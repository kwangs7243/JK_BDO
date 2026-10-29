from urllib.error import URLError
import sqlite3
import xml.etree.ElementTree as ET
from flask import Blueprint, current_app, jsonify, request

from .catalog import CATEGORIES, icon_url, identity, index

craft_pages = Blueprint("craft", __name__, url_prefix="/craft", static_folder="frontend", static_url_path="/assets")
craft_api = Blueprint("craft_api", __name__, url_prefix="/api/craft")


@craft_pages.get("/", strict_slashes=False)
def page():
    return craft_pages.send_static_file("index.html")


@craft_api.get("/catalog")
def catalog():
    data = index()
    return jsonify({"items": [{**item, "icon": icon_url(item["icon"])} for item in data["items"]],
                    "categories": CATEGORIES, "source": data["source"], "fetchedAt": data["fetchedAt"]})


@craft_api.get("/bootstrap")
def bootstrap():
    store = current_app.extensions["craft_storage"]
    return jsonify({"inventory": store.inventory(), "preferences": store.preferences()})


@craft_api.get("/items/<item_id>")
def item(item_id):
    return jsonify(current_app.extensions["craft_storage"].item(identity(item_id)))


@craft_api.put("/preferences")
def preferences():
    body = request.get_json()
    if not isinstance(body, dict) or set(body) != {"revision", "favorites"}:
        raise ValueError("즐겨찾기 저장 내용을 확인하세요.")
    return jsonify(current_app.extensions["craft_storage"].save_preferences(body["revision"], body["favorites"]))


@craft_api.errorhandler(ValueError)
@craft_api.errorhandler(ET.ParseError)
def invalid(error):
    return jsonify({"error": {"message": str(error)}}), 422


@craft_api.errorhandler(RuntimeError)
def conflict(error):
    return jsonify({"error": {"message": str(error)}}), 409


@craft_api.errorhandler(URLError)
@craft_api.errorhandler(TimeoutError)
@craft_api.errorhandler(sqlite3.Error)
def unavailable(error):
    return jsonify({"error": {"message": "자료를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요. 기존 계산은 유지됩니다."}}), 503
