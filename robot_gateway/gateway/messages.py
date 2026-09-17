"""Validate cloud <-> gateway messages against the JSON Schema emitted from packages/contracts."""
import json
from pathlib import Path
from jsonschema import Draft7Validator

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schema"

class MessageError(ValueError):
    pass

def _load(name: str) -> Draft7Validator:
    with open(SCHEMA_DIR / name, encoding="utf-8") as f:
        return Draft7Validator(json.load(f))

_DOWN = _load("gateway-down.json")
_UP = _load("gateway-up.json")

def _check(validator: Draft7Validator, msg: dict) -> None:
    errors = sorted(validator.iter_errors(msg), key=lambda e: list(e.path))
    if errors:
        raise MessageError("; ".join(e.message for e in errors[:3]))

def validate_down(msg: dict) -> None:
    _check(_DOWN, msg)

def validate_up(msg: dict) -> None:
    _check(_UP, msg)
