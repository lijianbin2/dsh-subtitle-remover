#!/usr/bin/env python
"""Headless bridge between the DSH subtitle-remover plugin and the
video-subtitle-remover engine (https://github.com/YaoFANGUK/video-subtitle-remover).

Protocol: one JSON object per line on the real stdout, prefixed with ``@@VSR@@``.
Everything the engine (and tqdm, paddle, torch) prints is redirected to stderr so
that channel stays parseable. The plugin parses these events and turns them into
job progress.

    python vsr_runner.py --vsr-root DIR --video FILE --output FILE
                         [--mode sttn-auto] [--detect server|mobile]
                         [--area ymin,ymax,xmin,xmax]

Arguments and progress handling mirror ``backend/main.py``'s own CLI entry, but
this script keeps stdout clean and reports structured progress instead of a tqdm
bar, which is what a UI needs.
"""

import argparse
import json
import os
import sys
import time
import traceback

CHANNEL_PREFIX = '@@VSR@@ '

# The only writer of real stdout; set before any redirect so the engine's prints
# cannot interleave with protocol lines.
_CHANNEL = sys.stdout


def emit(**payload):
    payload.setdefault('time', round(time.time(), 3))
    try:
        _CHANNEL.write(CHANNEL_PREFIX + json.dumps(payload, ensure_ascii=False) + '\n')
        _CHANNEL.flush()
    except Exception:  # never let reporting break the run
        pass


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Headless video-subtitle-remover runner for DSH')
    parser.add_argument('--vsr-root', required=True, help='video-subtitle-remover checkout directory')
    parser.add_argument('--video', required=True, help='input video or image')
    parser.add_argument('--output', required=True, help='output file path')
    parser.add_argument('--mode', default='sttn-auto',
                        choices=['sttn-auto', 'sttn-det', 'lama', 'propainter', 'opencv'])
    parser.add_argument('--detect', default='server', choices=['server', 'mobile'])
    parser.add_argument('--area', action='append', default=[],
                        help='subtitle area as percentages "yMin,yMax,xMin,xMax"; repeatable')
    parser.add_argument('--start', type=float, default=None, help='processing range start in seconds')
    parser.add_argument('--end', type=float, default=None, help='processing range end in seconds')
    parser.add_argument('--preview-dir', default='', help='directory for live before/after JPEGs')
    return parser.parse_args(argv)


def parse_area(raw, width, height):
    parts = [p for p in str(raw).replace(';', ',').split(',') if p.strip() != '']
    if len(parts) != 4:
        raise ValueError(f'字幕区域格式应为 yMin,yMax,xMin,xMax：{raw}')
    try:
        y_min, y_max, x_min, x_max = (float(p) for p in parts)
    except ValueError as error:
        raise ValueError(f'字幕区域不是数字：{raw}（{error}）')
    return (
        max(0, min(height, int(round(y_min / 100.0 * height)))),
        max(0, min(height, int(round(y_max / 100.0 * height)))),
        max(0, min(width, int(round(x_min / 100.0 * width)))),
        max(0, min(width, int(round(x_max / 100.0 * width)))),
    )


def run(args):
    started = time.time()

    sys.stdout = sys.stderr
    # backend/main.py hands tqdm `sys.__stdout__` explicitly, so this redirect is
    # what keeps its progress bar out of the JSON channel.
    sys.__stdout__ = sys.stderr

    root = os.path.abspath(args.vsr_root)
    video = os.path.abspath(args.video)
    output = os.path.abspath(args.output)

    emit(type='stage', stage='loading', message='加载 video-subtitle-remover…')
    os.chdir(root)
    if root not in sys.path:
        sys.path.insert(0, root)

    from backend.config import config
    from backend.tools.constant import InpaintMode, SubtitleDetectMode

    config.inpaintMode.value = InpaintMode(args.mode)
    config.subtitleDetectMode.value = (
        SubtitleDetectMode.PP_OCRv5_MOBILE if args.detect == 'mobile' else SubtitleDetectMode.PP_OCRv5_SERVER
    )

    from backend.main import SubtitleRemover

    emit(type='stage', stage='loading', message='读取视频信息…')
    remover = SubtitleRemover(video)
    width = int(remover.frame_width or 0)
    height = int(remover.frame_height or 0)
    total = 1 if remover.is_picture else int(remover.frame_count or 0)
    emit(type='video', width=width, height=height, frames=total, fps=round(float(remover.fps or 0), 3))

    areas = [parse_area(raw, width, height) for raw in args.area]
    if not areas:
        areas = [(0, height, 0, width)]
    remover.sub_areas = areas
    remover.video_out_path = output

    # The engine only reports preview frames in GUI mode; the comparison images
    # below replace the GUI widget.
    remover.gui_mode = True

    fps = float(remover.fps or 0.0)
    frame_count = int(remover.frame_count or 0)
    range_frames = None
    if not remover.is_picture and frame_count > 0 and fps > 0 and (args.start is not None or args.end is not None):
        start_seconds = max(0.0, float(args.start if args.start is not None else 0.0))
        end_seconds = float(args.end) if args.end is not None else frame_count / fps
        start_frame = max(0, min(frame_count - 1, int(round(start_seconds * fps))))
        end_frame = max(start_frame + 1, min(frame_count, int(round(end_seconds * fps))))
        if end_frame <= start_frame:
            raise ValueError('处理区间的结束时间必须晚于开始时间')
        remover.ab_sections = [range(start_frame, end_frame)]
        range_frames = (start_frame, end_frame)
        emit(type='note', message=(
            f'处理区间: 帧 {start_frame}–{end_frame - 1} / 共 {frame_count} '
            f'（{start_frame / fps:.2f}s–{end_frame / fps:.2f}s）'
        ))

    preview_dir = args.preview_dir
    if preview_dir:
        try:
            os.makedirs(preview_dir, exist_ok=True)
        except Exception:
            traceback.print_exc()
            preview_dir = ''

    preview_state = {'last': 0.0, 'seq': 0, 'percent': -1}
    preview_width = 640

    def write_preview(frame_ori, frame_comp):
        """Throttled before/after JPEGs for the page's live comparison strip."""
        if not preview_dir:
            return
        percent = int(remover.progress_total or 0)
        if range_frames is not None:
            # Frames outside the processing range are copied untouched, so their
            # comparison would be a pointless identical pair.
            frame_no = int(percent / 100.0 * max(1, total))
            if not (range_frames[0] <= frame_no < range_frames[1]):
                return
        now = time.time()
        # Time-based throttle, plus forced checkpoints so short clips still show a
        # late frame instead of only the first one.
        checkpoint = percent - preview_state['percent'] >= 20
        if not checkpoint and now - preview_state['last'] < 0.5:
            return
        preview_state['last'] = now
        preview_state['percent'] = percent
        preview_state['seq'] += 1
        try:
            import cv2
            for name, image in (('left', frame_ori), ('right', frame_comp)):
                if image is None:
                    continue
                height_px, width_px = image.shape[:2]
                if width_px > preview_width:
                    scaled = cv2.resize(
                        image,
                        (preview_width, max(1, int(height_px * preview_width / width_px))),
                        interpolation=cv2.INTER_AREA,
                    )
                else:
                    scaled = image
                temp_path = os.path.join(preview_dir, f'{name}.tmp.jpg')
                final_path = os.path.join(preview_dir, f'{name}.jpg')
                if cv2.imwrite(temp_path, scaled, [int(cv2.IMWRITE_JPEG_QUALITY), 78]):
                    os.replace(temp_path, final_path)
            emit(type='preview', seq=preview_state['seq'], percent=int(remover.progress_total or 0), total=total)
        except Exception:
            traceback.print_exc()

    remover.update_preview_with_comp = write_preview

    os.makedirs(os.path.dirname(output) or '.', exist_ok=True)
    emit(type='note', message='字幕区域(像素 yMin,yMax,xMin,xMax): ' + ', '.join(str(area) for area in areas))
    emit(type='note', message=f'擦除算法: {args.mode} · 检测模型: {args.detect}')

    last_percent = [-1]

    def on_progress(percent, finished):
        value = int(percent)
        if value == last_percent[0]:
            return
        last_percent[0] = value
        emit(type='progress', percent=value, total=total, finished=bool(finished))

    remover.add_progress_listener(on_progress)

    emit(type='stage', stage='running', message='开始擦除字幕…')
    remover.run()

    final_path = remover.video_out_path or output
    emit(type='done', outputPath=final_path, frames=total, seconds=round(time.time() - started, 1))
    return 0


def main(argv=None):
    args = parse_args(argv)
    try:
        return run(args)
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001 - report anything the engine raises
        message = str(error) or error.__class__.__name__
        emit(type='failed', message=message, detail=traceback.format_exc()[-6000:])
        return 1


if __name__ == '__main__':
    sys.exit(main())
