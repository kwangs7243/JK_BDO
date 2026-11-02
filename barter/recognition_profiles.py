"""Pinned original-pixel numeric profiles and their persisted evidence contract."""
from __future__ import annotations

from functools import lru_cache
import hashlib
import json
from pathlib import Path


PROFILE_ROOT = Path(__file__).resolve().parent / "recognition_data"
PROFILE_FILES = {
    "warehouse": ("numeric-profile-warehouse.json", "e62cc8a2d52226de7bd10c45a8d363c534786aabbb374c555f1dc984177f4a07"),
    "trade": ("numeric-profile-trade.json", "6d9ee193fbb40a510b59e86aef2036cadc4bcfff53e8c4b56c3521ee67ee15f2"),
}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


@lru_cache(maxsize=2)
def load_numeric_profile(kind):
    try:
        filename, expected = PROFILE_FILES[kind]
        raw = (PROFILE_ROOT / filename).read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            return None
        profile = json.loads(raw)
        content = {k:v for k,v in profile.items() if k != "sha256"}
        if (profile["status"] != "VERIFIED_ORIGINAL_GLYPHS" or
                hashlib.sha256(_canonical(content)).hexdigest() != profile["sha256"]):
            return None
        return profile
    except (OSError, ValueError, KeyError, TypeError):
        return None


@lru_cache(maxsize=3)
def _references(kind, context):
    profile = load_numeric_profile(kind)
    if profile is None:
        return {}
    glyphs = profile["glyphs"] if kind == "warehouse" else profile["contexts"][context]["glyphs"]
    return {(g["digit"], _canonical(g["source"])): g["referenceId"] for g in glyphs}


def numeric_profile_result(kind, field, result, *, input_sha256):
    profile = load_numeric_profile(kind)
    if profile is None or result.get("status") != "QUANTITY_MATCH" or type(result.get("value")) is not int:
        return None
    context = "yellow" if field == "count" else "white"
    raw = result.get("numericEvidence", {})
    if not isinstance(raw, dict):
        return None
    if kind == "trade" and (field not in {"count", "reqAmount", "yield"}
            or (field == "count" and raw.get("suffix", {}).get("verification") != "ORIGINAL_GLYPH_AUDIT")):
        return None
    glyphs = raw.get("glyphs", [])
    if raw.get("completeToken") is not True or not 1 <= len(glyphs) <= 4:
        return None
    references = _references(kind, context)
    evidence = []
    for glyph in glyphs:
        reference = references.get((glyph["digit"], _canonical(glyph["source"])))
        if reference is None:
            return None
        evidence.append({"digit": glyph["digit"], "referenceId": reference,
                         "pixelDifference": glyph["difference"],
                         "box": [glyph["x"], glyph["y"], glyph["end"]-glyph["x"], glyph["height"]]})
    text = "".join(str(g["digit"]) for g in evidence)
    if int(text) != result["value"] or (len(text) > 1 and text.startswith("0")):
        return None
    token = {"version": 1, "profileKind": kind, "field": field,
             "profileFileSha256": PROFILE_FILES[kind][1], "profileSha256": profile["sha256"],
             "algorithm": profile["version"], "completeToken": True, "inputSha256": input_sha256,
             "digits": evidence, "pixelDifference": raw.get("difference"),
             "nextDifference": raw.get("nextDifference")}
    if "suffix" in raw:
        token["suffix"] = raw["suffix"]
    return {"status": "QUANTITY_MATCH", "value": result["value"], "rawOCR": "", "variants": [],
            "confidence": None, "method": "verified-original-pixel-numeric-profile",
            "valueSource": "VERIFIED_NUMERIC_PROFILE", "numericEvidence": token}


def verified_numeric_profile_field(field, name):
    """Resolve proof, references and value together; a source label alone is insufficient."""
    if field.get("valueSource") != "VERIFIED_NUMERIC_PROFILE" or field.get("reviewRequired") is not False:
        return False
    proof = field.get("numericEvidence", {})
    if not isinstance(proof, dict):
        return False
    kind = proof.get("profileKind")
    if kind != "trade" or name not in {"count", "reqAmount", "yield"} or proof.get("field") != name or proof.get("completeToken") is not True:
        return False
    profile = load_numeric_profile(kind)
    if (profile is None or proof.get("version") != 1 or proof.get("profileFileSha256") != PROFILE_FILES[kind][1]
            or proof.get("profileSha256") != profile["sha256"] or proof.get("algorithm") != profile["version"]):
        return False
    value = field.get("corrected")
    if type(value) is not int or not (0 if name == "count" else 1) <= value <= (10 if name == "count" else 9999):
        return False
    context = "yellow" if name == "count" else "white"
    refs = {reference: digit for (digit, source), reference in _references(kind, context).items()}
    digits = proof.get("digits")
    if not isinstance(digits, list) or not 1 <= len(digits) <= 4:
        return False
    if any(not isinstance(g, dict) or type(g.get("digit")) is not int or not isinstance(g.get("referenceId"), str)
           or refs.get(g["referenceId"]) != g["digit"] for g in digits):
        return False
    image_hash = proof.get("inputSha256")
    if not isinstance(image_hash, str) or len(image_hash) != 64 or any(c not in "0123456789abcdef" for c in image_hash):
        return False
    if name == "count":
        suffix = proof.get("suffix")
        if not isinstance(suffix, dict) or suffix.get("verification") != "ORIGINAL_GLYPH_AUDIT":
            return False
    text = "".join(str(g["digit"]) for g in digits)
    return not (len(text) > 1 and text.startswith("0")) and int(text) == value
