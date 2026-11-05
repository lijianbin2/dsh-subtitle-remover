#!/usr/bin/env python
"""Detect subtitle regions for the DSH subtitle-remover plugin.

Samples frames across the video, runs video-subtitle-remover's own text detector
(PP-OCR det) on them, clusters the boxes into a few subtitle bands, and reports
them as percentages of the frame. The plugin uses the result to fill the region
editor or to run a fully automatic job.

Protocol: one JSON object per line on the real stdout, prefixed with ``@@VSR@@``;
engine/paddle chatter goes to stderr.

    python vsr_detect.py --vsr-root DIR --video FILE [--samples 14] [--max-regions 4]
"""

import argparse
import json
import os
import sys
import time
import traceback

CHANNEL_PREFIX = '@@VSR@@ '
_CHANNEL = sys.stdout


def emit(**payload):
    payload.setdefault('time', round(time.time(), 3))
    try:
        _CHANNEL.write(CHANNEL_PREFIX + json.dumps(payload, ensure_ascii=False) + '\n')
        _CHANNEL.flush()
    except Exception:  # reporting must never break detection
        pass


def parse_args(argv):
    parser = argparse.ArgumentParser(description='Subtitle region detection for DSH')
    parser.add_argument('--vsr-root', required=True)
    parser.add_argument('--video', required=True)
    parser.add_argument('--samples', type=int, default=14)
    parser.add_argument('--max-regions', type=int, default=4)
    return parser.parse_args(argv)


def sample_indices(total, count):
    if total <= 1:
        return [0]
    count = max(1, min(count, total))
    if count == 1:
        return [total // 2]
    picks = set()
    for i in range(count):
        ratio = 0.06 + 0.88 * (i / (count - 1))
        picks.add(min(total - 1, max(0, int(round(total * ratio)))))
    return sorted(picks)


def wide_enough(xmin, xmax, ymin, ymax):
    width = xmax - xmin
    height = ymax - ymin
    if width < 8 or height < 4:
        return False
    # A subtitle line is wider than tall; VSR applies the same sanity rule.
    return width / max(1.0, height) >= 1.2


def cluster_boxes(boxes, min_hits):
    """Merge per-frame boxes into subtitle bands (pixel space)."""
    clusters = []
    for frame_no, xmin, xmax, ymin, ymax in boxes:
        if not wide_enough(xmin, xmax, ymin, ymax):
            continue
        center_y = (ymin + ymax) / 2.0
        placed = False
        for cluster in clusters:
            cluster_height = cluster['ymax'] - cluster['ymin']
            cluster_center = (cluster['ymin'] + cluster['ymax']) / 2.0
            if abs(center_y - cluster_center) > 0.6 * max(ymax - ymin, cluster_height):
                continue
            overlap = max(0.0, min(xmax, cluster['xmax']) - max(xmin, cluster['xmin']))
            if overlap / max(1.0, min(xmax - xmin, cluster['xmax'] - cluster['xmin'])) < 0.25:
                continue
            cluster['xmin'] = min(cluster['xmin'], xmin)
            cluster['xmax'] = max(cluster['xmax'], xmax)
            cluster['ymin'] = min(cluster['ymin'], ymin)
            cluster['ymax'] = max(cluster['ymax'], ymax)
            cluster['frames'].add(frame_no)
            placed = True
            break
        if not placed:
            clusters.append({
                'xmin': xmin, 'xmax': xmax, 'ymin': ymin, 'ymax': ymax,
                'frames': {frame_no},
            })
    kept = [cluster for cluster in clusters if len(cluster['frames']) >= min_hits]
    kept.sort(key=lambda cluster: (-len(cluster['frames']), cluster['ymin']))
    return kept


def to_percent(cluster, width, height, sampled):
    height_px = max(1.0, cluster['ymax'] - cluster['ymin'])
    width_px = max(1.0, cluster['xmax'] - cluster['xmin'])
    pad_y = max(0.6, (height_px / height) * 100.0 * 0.3)
    pad_x = max(0.6, (width_px / width) * 100.0 * 0.08)
    return {
        'yMin': round(max(0.0, cluster['ymin'] / height * 100.0 - pad_y), 1),
        'yMax': round(min(100.0, cluster['ymax'] / height * 100.0 + pad_y), 1),
        'xMin': round(max(0.0, cluster['xmin'] / width * 100.0 - pad_x), 1),
        'xMax': round(min(100.0, cluster['xmax'] / width * 100.0 + pad_x), 1),
        'hits': len(cluster['frames']),
        'score': round(len(cluster['frames']) / max(1, sampled) * 100),
    }


# A burned-in subtitle is a wide, horizontally centred band that shows up on most
# sampled frames. HUD text (ammo counters, kill feeds, minimaps) is short and sits
# in a corner, so width + centring separate the two far better than hit count.
MIN_WIDTH_RATIO = 0.05
MIN_HITS_RATIO = 0.2
MAX_HEIGHT_RATIO = 0.45


def subtitle_score(cluster, width, height, sampled):
    width_ratio = (cluster['xmax'] - cluster['xmin']) / max(1.0, width)
    height_ratio = (cluster['ymax'] - cluster['ymin']) / max(1.0, height)
    center_x = ((cluster['xmin'] + cluster['xmax']) / 2.0) / max(1.0, width)
    center_y = ((cluster['ymin'] + cluster['ymax']) / 2.0) / max(1.0, height)
    hits_ratio = len(cluster['frames']) / max(1, sampled)

    width_score = min(1.0, width_ratio / 0.5)
    center_score = max(0.0, 1.0 - abs(center_x - 0.5) / 0.35)
    vertical_score = 1.0 if center_y >= 0.55 else (0.5 if center_y >= 0.3 else 0.25)
    return (
        width_ratio,
        height_ratio,
        hits_ratio,
        0.45 * width_score + 0.35 * center_score + 0.15 * hits_ratio + 0.05 * vertical_score,
    )


def select_clusters(clusters, width, height, sampled, max_regions):
    """Keep the bands that look like subtitles, best first."""
    scored = []
    for cluster in clusters:
        width_ratio, height_ratio, hits_ratio, score = subtitle_score(cluster, width, height, sampled)
        if width_ratio < MIN_WIDTH_RATIO or hits_ratio < MIN_HITS_RATIO:
            continue
        if height_ratio > MAX_HEIGHT_RATIO:
            continue
        scored.append((score, cluster))
    if not scored:
        return [], []
    scored.sort(key=lambda item: -item[0])
    cutoff = max(0.45, scored[0][0] * 0.65)
    kept = [cluster for score, cluster in scored if score >= cutoff][:max_regions]
    return kept, [(round(score, 3), cluster) for score, cluster in scored]



def run(args):
    started = time.time()
    sys.stdout = sys.stderr
    sys.__stdout__ = sys.stderr

    root = os.path.abspath(args.vsr_root)
    video = os.path.abspath(args.video)
    os.chdir(root)
    if root not in sys.path:
        sys.path.insert(0, root)

    import cv2
    from backend.tools.subtitle_detect import SubtitleDetect

    emit(type='stage', stage='loading', message='加载字幕文本检测模型…')
    detector = SubtitleDetect(video, [])
    capture = cv2.VideoCapture(video)
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) + 0.5)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = round(float(capture.get(cv2.CAP_PROP_FPS) or 0.0), 3)
    if not width or not height:
        raise RuntimeError('读不出画面尺寸，可能不是受支持的视频/图片')

    if total <= 1:  # a still image
        ok, frame = capture.read()
        capture.release()
        if not ok or frame is None:
            raise RuntimeError('读不出画面，可能文件已损坏')
        indices = [0]
        boxes = [(0, *box) for box in detector.detect_subtitle(frame)]
        sampled = 1
        emit(type='progress', percent=100, sampled=sampled)
    else:
        indices = sample_indices(total, args.samples)
        emit(type='stage', stage='detecting', message=f'在 {len(indices)} 个采样帧上检测字幕…')
        boxes = []
        sampled = 0
        for position, frame_no in enumerate(indices, start=1):
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            sampled += 1
            for xmin, xmax, ymin, ymax in detector.detect_subtitle(frame):
                boxes.append((frame_no, int(xmin), int(xmax), int(ymin), int(ymax)))
            emit(type='progress', percent=round(position / len(indices) * 100), sampled=sampled,
                 message=f'已检测 {position}/{len(indices)} 帧')
        capture.release()

    min_hits = max(1, int(round(sampled * 0.15)))
    clusters = cluster_boxes(boxes, min_hits)
    kept, scored = select_clusters(clusters, width, height, sampled, max(1, args.max_regions))
    regions = [to_percent(cluster, width, height, sampled) for cluster in kept]
    # Every plausible band, so a model can review the heuristics instead of only
    # the winner.
    candidates = [to_percent(cluster, width, height, sampled) for _, cluster in scored[:8]]
    if scored:
        preview = '；'.join(
            f"y {round(cluster['ymin'] / height * 100)}–{round(cluster['ymax'] / height * 100)}% → {score}"
            for score, cluster in scored[:5]
        )
        emit(type='note', message=f'候选字幕带（宽/居中/命中评分）：{preview}')

    emit(type='regions', regions=regions, candidates=candidates, sampled=sampled, boxes=len(boxes),
         width=width, height=height, fps=fps)
    if not regions:
        emit(type='note', message='没有找到稳定的字幕文本框')
    emit(type='done', regions=regions, sampled=sampled, seconds=round(time.time() - started, 1))
    return 0


def main(argv=None):
    args = parse_args(argv)
    try:
        return run(args)
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001
        message = str(error) or error.__class__.__name__
        emit(type='failed', message=message, detail=traceback.format_exc()[-6000:])
        return 1


if __name__ == '__main__':
    sys.exit(main())
