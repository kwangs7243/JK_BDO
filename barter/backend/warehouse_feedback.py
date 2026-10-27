"""Validate current scanner feedback in the same transaction as stock application."""
import json
from .contracts import ContractError, require_object, require_int

AGREEMENTS = {"item_only": (True, False), "quantity_only": (False, True),
              "both_match": (True, True), "both_different": (False, False)}


def warehouse_requires_image(report):
    slots = report.get("slots", [])
    return not slots or any(slot.get("decision") not in {"MATCH", "EMPTY", "TIER5_IGNORE"} for slot in slots)


def retain_feedback_image(connection, feedback, corrected):
    record = connection.execute("SELECT image_png, provenance_json FROM warehouse_scan WHERE scan_id = ?", (feedback["scanId"],)).fetchone()
    if record["image_png"] or not corrected["rows"]:
        return
    import base64
    import binascii
    import hashlib
    provenance = json.loads(record["provenance_json"])
    source = feedback.get("sourceImagePng")
    if not isinstance(source, str) or len(source) > 28 * 1024 * 1024:
        raise ContractError("수정한 판독의 원본 이미지가 필요합니다. 이미지를 다시 판독하세요.")
    try:
        image = base64.b64decode(source, validate=True)
    except (ValueError, binascii.Error):
        raise ContractError("수정한 판독의 원본 이미지 형식이 올바르지 않습니다.") from None
    collection = provenance.get("collection", {})
    if (not image.startswith(b"\x89PNG\r\n\x1a\n") or len(image) > 20 * 1024 * 1024
            or hashlib.sha256(image).hexdigest() != collection.get("imageSha256")):
        raise ContractError("수정한 판독의 이미지가 원본과 일치하지 않습니다.")
    collection.update(imageRetained=True, retainedFor="USER_FEEDBACK")
    connection.execute("UPDATE warehouse_scan SET image_png = ?, provenance_json = ? WHERE scan_id = ?",
                       (image, json.dumps(provenance, ensure_ascii=False), feedback["scanId"]))


def validate_feedback(connection, feedback, updates, catalog):
    feedback = require_object(feedback, "feedback")
    if (not {"scanId", "rows", "version"} <= set(feedback)
            or set(feedback) - {"scanId", "rows", "version", "sourceImagePng"} or type(feedback["version"]) is not int
            or feedback["version"] != 2 or not isinstance(feedback["scanId"], str)
            or not isinstance(feedback["rows"], list)):
        raise ContractError("판독 기록 형식이 올바르지 않습니다.")
    record = connection.execute("SELECT report_json FROM warehouse_scan WHERE scan_id = ?", (feedback["scanId"],)).fetchone()
    if record is None:
        raise ContractError("원본 판독 기록이 없습니다. 이미지를 다시 판독하세요.")
    report = json.loads(record["report_json"])
    slots = {slot["slot"]: slot for slot in report["slots"] if slot["decision"] not in {"EMPTY", "TIER5_IGNORE"}}
    rows = feedback["rows"]
    if any(not isinstance(row, dict) or set(row) != {"slot", "name", "quantity", "excluded", "agreement"}
           or not isinstance(row["slot"], str) for row in rows):
        raise ContractError("사용자 확인 행 형식이 올바르지 않습니다.")
    if len(rows) != len(slots) or {row["slot"] for row in rows} != set(slots):
        raise ContractError("모든 판독 칸의 확인값이 필요합니다.")
    expected, corrected = {}, []
    for row in rows:
        check = row["agreement"]
        if type(row["excluded"]) is not bool or not isinstance(check, str) or check not in {"unchecked", *AGREEMENTS}:
            raise ContractError("품목·수량 일치 확인 상태가 올바르지 않습니다.")
        slot = slots[row["slot"]]
        if row["excluded"]:
            if check != "unchecked" or row["name"] is not None or row["quantity"] is not None:
                raise ContractError("비대상 칸은 품목 정답으로 저장할 수 없습니다.")
            corrected.append(row)
            continue
        name = row["name"]
        if not isinstance(name, str) or name not in catalog or catalog[name] > 4:
            raise ContractError("1~4단 정본 품목을 선택하세요.")
        quantity = require_int(row["quantity"], "feedback.quantity")
        guess = slot.get("finalItem") or slot.get("bestCandidate")
        original_quantity = (slot.get("quantity") or {}).get("value")
        observed = (name == guess, type(original_quantity) is int and quantity == original_quantity)
        if check != "unchecked" and AGREEMENTS[check] != observed:
            raise ContractError("선택한 일치 여부가 원본 판독값·최종 수정값과 다릅니다.")
        expected[name] = require_int(expected.get(name, 0) + quantity, "combined quantity")
        if observed != (True, True) or slot["decision"] != "MATCH" and check != "unchecked":
            corrected.append(row)
    if expected != {name: value["stock"] for name, value in updates.items()}:
        raise ContractError("사용자 확인값과 적용 재고가 일치하지 않습니다.")
    return {"version": 2, "scanId": feedback["scanId"], "rows": corrected}


def label_verification(row):
    if not row["excluded"] and row["agreement"] in AGREEMENTS:
        item_match, quantity_match = AGREEMENTS[row["agreement"]]
        return {"verifiedItemLabel": True, "verifiedQuantityLabel": True,
                "itemMatch": item_match, "quantityMatch": quantity_match}
    return {"verifiedItemLabel": False, "verifiedQuantityLabel": False, "itemMatch": None, "quantityMatch": None}
