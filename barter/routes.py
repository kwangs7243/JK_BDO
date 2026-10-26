"""Barter page and its existing asset URLs."""
import json
from pathlib import Path
from flask import Blueprint, jsonify, send_from_directory

barter_pages = Blueprint("barter", __name__, static_folder="frontend", static_url_path="/assets")


@barter_pages.get("/barter/", strict_slashes=False)
def index():
    return barter_pages.send_static_file("index.html")


@barter_pages.get("/assets/data/inventory-icons.json")
def inventory_icons():
    reference = Path(__file__).resolve().parents[1] / "reference"
    catalog = json.loads((reference / "barter_items.json").read_text(encoding="utf-8"))
    return jsonify({item["programName"]: f"/assets/item-icons/{item['itemId']}.webp?v={item['iconSha256'][:12]}"
                    for item in catalog["items"]})


@barter_pages.get("/assets/item-icons/<int:item_id>.webp")
def inventory_icon(item_id):
    return send_from_directory(Path(__file__).resolve().parents[1] / "reference/icons", f"{item_id}.webp", max_age=86400)
