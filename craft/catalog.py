from functools import lru_cache
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

SOURCE = "https://www.korbdo.co.kr"
CATEGORIES = {"alchemy": "연금", "cooking": "요리", "manufacture": "가공", "houseCraft": "공방", "nodeProduct": "거점", "collect": "채집", "fishing": "낚시", "etc": "기타"}
METHODS = {"MANUFACTURE_HEAT": "가열하기", "MANUFACTURE_GRIND": "빻기", "MANUFACTURE_DRY": "말리기", "MANUFACTURE_SHAKE": "흔들어 섞기", "MANUFACTURE_THINNING": "솎아내기", "MANUFACTURE_FIREWOOD": "장작패기", "MANUFACTURE_SIMPLE_ALCHEMY": "간이 연금", "MANUFACTURE_SIMPLE_COOK": "간이 요리"}


@lru_cache(maxsize=1)
def index():
    return json.loads((Path(__file__).parent / "data/index.json").read_text(encoding="utf-8"))


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value):
        raise ValueError("올바른 품목을 선택하세요.")
    return value


def icon_url(filename):
    return SOURCE + "/png/" + filename if re.fullmatch(r"[\w-]+\.png", filename or "", re.ASCII) else None


def parse_item(raw, expected_id):
    if len(raw) > 2 * 1024 * 1024 or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("품목 자료의 형식을 확인할 수 없습니다.")
    root = ET.fromstring(raw)
    if root.tag != "itemInfo" or root.findtext("itemKey") != expected_id:
        raise ValueError("요청한 품목과 원본 자료가 다릅니다.")
    result = {"id": expected_id, "name": root.findtext("itemName", ""), "icon": icon_url(root.findtext("itemIcon")),
              "description": root.findtext("itemDesc", "").replace("\\n", "\n"), "recipes": [], "related": [],
              "source": SOURCE + "/xml/ko-kr/" + expected_id + ".xml"}
    for group in root:
        if group.tag not in {"alchemy", "cook", "house", "manufacture", "makelist"}:
            continue
        action = group.get("action", "")
        related = group.tag == "makelist" or "ROYALGIFT" in action
        inputs = []
        for item in group.findall("item"):
            item_id = item.findtext("id", "")
            if not re.fullmatch(r"[0-9]{1,10}", item_id):
                continue
            count = item.findtext("count", "")
            quantity = int(count) if re.fullmatch(r"[1-9][0-9]{0,8}", count) else None
            inputs.append({"id": item_id, "name": item.findtext("name", ""), "icon": icon_url(item.findtext("icon")), "quantity": quantity})
        if related:
            result["related"].extend(inputs)
        elif inputs:
            method = {"alchemy": "주거지 연금", "cook": "주거지 요리", "house": "공방 제작"}.get(group.tag, METHODS.get(action, "가공"))
            result["recipes"].append({"id": str(len(result["recipes"])), "method": method, "action": action,
                                      "inputs": inputs, "outputQuantity": None})
    if not result["name"]:
        raise ValueError("품목 이름이 없는 자료입니다.")
    return result
