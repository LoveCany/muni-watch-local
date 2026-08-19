import argparse
import json
import os
import sys
import traceback

import cv2
import paddle
from paddleocr import TextRecognition


MARKER = "@@MUNI_PPOCR@@"


def emit(payload):
    print(f"{MARKER}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", flush=True)


def crop(image, rectangle):
    left = int(rectangle["left"])
    top = int(rectangle["top"])
    width = int(rectangle["width"])
    height = int(rectangle["height"])
    if left < 0 or top < 0 or width <= 0 or height <= 0:
        raise ValueError(f"invalid crop rectangle: {rectangle}")
    bottom = top + height
    right = left + width
    if bottom > image.shape[0] or right > image.shape[1]:
        raise ValueError(f"crop rectangle exceeds screenshot: {rectangle}")
    return image[top:bottom, left:right]


def enlarge(image, scale=3):
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def score_contrast(image):
    gray = cv2.cvtColor(enlarge(image), cv2.COLOR_BGR2GRAY)
    enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


def result_payload(result):
    data = result.json["res"]
    return {"text": str(data["rec_text"]), "confidence": float(data["rec_score"])}


def recognize(model, request, batch_size):
    screenshot = cv2.imread(request["imagePath"], cv2.IMREAD_COLOR)
    if screenshot is None:
        raise ValueError(f"could not read screenshot: {request['imagePath']}")

    rows = request["rows"]
    name_images = []
    score_originals = []
    score_contrasts = []
    for row in rows:
        name_images.append(enlarge(crop(screenshot, row["name"])))
        score_image = crop(screenshot, row["score"])
        score_originals.append(enlarge(score_image))
        score_contrasts.append(score_contrast(score_image))

    images = name_images + score_originals + score_contrasts
    predictions = list(model.predict(images, batch_size=min(batch_size, len(images))))
    if len(predictions) != len(images):
        raise RuntimeError(f"expected {len(images)} predictions, got {len(predictions)}")

    count = len(rows)
    entries = []
    for index, row in enumerate(rows):
        entries.append({
            "rank": int(row["rank"]),
            "name": result_payload(predictions[index]),
            "scoreCandidates": [
                {**result_payload(predictions[count + index]), "variant": "original"},
                {**result_payload(predictions[count * 2 + index]), "variant": "contrast"},
            ],
        })
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir")
    parser.add_argument("--device", required=True)
    parser.add_argument("--batch-size", type=int, default=21)
    args = parser.parse_args()

    if not args.device.startswith("gpu"):
        raise RuntimeError("PP-OCR must be configured with a GPU device")
    if not paddle.device.is_compiled_with_cuda() or paddle.device.cuda.device_count() < 1:
        raise RuntimeError("PaddlePaddle GPU runtime is unavailable")

    paddle.set_device(args.device)
    model_options = {"model_name": args.model, "device": args.device}
    if args.model_dir and os.path.isdir(args.model_dir):
        model_options["model_dir"] = args.model_dir
    model = TextRecognition(**model_options)
    emit({
        "type": "ready",
        "engine": "PaddleOCR",
        "model": args.model,
        "device": args.device,
        "gpu": paddle.device.cuda.get_device_name(0),
        "paddleVersion": paddle.__version__,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            entries = recognize(model, request, args.batch_size)
            emit({"type": "result", "id": request["id"], "entries": entries})
        except Exception as error:
            emit({
                "type": "error",
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": str(error),
                "trace": traceback.format_exc(limit=4),
            })


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    main()
