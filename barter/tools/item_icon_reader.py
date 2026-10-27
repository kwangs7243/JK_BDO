"""Font-independent item identity from the icon area above quantity overlays."""
from pathlib import Path
import numpy as np
from PIL import Image
from tools.warehouse_patch.warehouse_patch import load_reference


def _features(images):
    pixels = images[:, 1:26, 1:42].reshape(len(images), -1)
    gray = images[:, 1:26, 1:42] @ np.array([.299, .587, .114], dtype=np.float32)
    gray = gray.reshape(len(images), -1)
    normalized = (gray - gray.mean(axis=1, keepdims=True)) / (gray.std(axis=1, keepdims=True) + 1e-6)
    return pixels, (pixels * pixels).mean(axis=1), normalized, (normalized * normalized).mean(axis=1)


def _scores(slot, prepared):
    pixels, norms, gray, gray_norms = prepared
    query, query_norm, query_gray, query_gray_norm = _features(slot[None])
    color = np.sqrt(np.maximum(0, norms + query_norm[0] - 2 * np.einsum('ij,j->i', pixels, query[0]) / pixels.shape[1]))
    structure = np.sqrt(np.maximum(0, gray_norms + query_gray_norm[0] - 2 * np.einsum('ij,j->i', gray, query_gray[0]) / gray.shape[1])) / 2
    return .65 * color + .35 * structure


class ItemIconReader:
    def __init__(self, root=None):
        root = Path(root or Path(__file__).resolve().parents[2])
        self.items, self.references = load_reference(root / "reference/barter_items.json")
        self.prepared = _features(self.references)
        self.indexes = {item["programName"]: i for i, item in enumerate(self.items)}
        path = root / "barter/recognition_data/warehouse-icons.npz"
        self.extra, self.names = None, []
        if path.is_file():
            with np.load(path, allow_pickle=False) as data:
                self.extra = data["icons"].astype(np.float32) / 255
                self.names = list(data["names"])
        self.extra_prepared = _features(self.extra) if self.extra is not None else None

    def icon_scores(self, slot, items, references):
        scores = _scores(slot, self.prepared)
        order = np.argsort(scores)
        if self.extra is not None and (scores[order[0]] > .35 or scores[order[1]] - scores[order[0]] < .045):
            for name, score in zip(self.names, _scores(slot, self.extra_prepared)):
                if name in self.indexes:
                    scores[self.indexes[name]] = min(scores[self.indexes[name]], score)
        return scores

    def match_trade(self, row, field, allowed):
        x = .286 if field == "fromItem" else .665
        results = []
        size = round(row.width * .044)
        for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
            left, top = round(row.width * x) + dx, round(row.height * .18) + dy
            crop = row.crop((left + 1, top + 1, left + size - 1, top + size - 1)).resize((43, 43), Image.Resampling.LANCZOS)
            slot = np.asarray(crop, dtype=np.float32) / 255
            scores = self.icon_scores(slot, self.items, self.references)
            order = np.argsort(scores); first, second = int(order[0]), int(order[1])
            name = self.items[first]["programName"]
            if name in allowed and scores[first] <= .20 and scores[second] - scores[first] >= .075:
                results.append((float(scores[first]), name, float(scores[second] - scores[first])))
        if not results or len({value[1] for value in results}) != 1:
            return None
        score, name, gap = min(results)
        return {"rawOCR": "", "corrected": name, "reviewRequired": False, "confidence": None,
                "valueSource": "VERIFIED_ICON", "masterMatch": "RESOLVED", "variants": [],
                "iconEvidence": {"distance": score, "gap": gap, "region": "upper-icon-without-number"}}
