from __future__ import annotations

import json
import os
import posixpath
import re
from datetime import datetime
from pathlib import Path, PurePosixPath

import httpx
from bottle import Bottle, HTTPResponse, request, response, run, static_file


APP = Bottle()
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
AUTH_FILE = DATA_DIR / "auth.json"

SORT_FIELD_MAP = {
    "name": "FILENAME",
    "size": "SIZE",
    "type": "TYPE",
    "modified": "MODIFIED_TIME",
    "created": "CREATED_TIME",
    "opened": "OPEN_TIME",
}

SORT_ORDER_MAP = {"asc": 1, "desc": 0}


def json_response(payload: dict, status: int = 200) -> HTTPResponse:
    resp = HTTPResponse(body=json.dumps(payload, ensure_ascii=False), status=status)
    resp.content_type = "application/json; charset=utf-8"
    return resp


def normalize_remote_path(path: str | None) -> str:
    value = (path or "/").strip()
    if not value:
        return "/"
    if not value.startswith("/"):
        value = "/" + value
    value = posixpath.normpath(value)
    return "/" if value in {".", ""} else value


def join_remote_path(base: str, *parts: str) -> str:
    path = PurePosixPath(normalize_remote_path(base))
    for part in parts:
        path = path.joinpath(PurePosixPath(str(part)))
    value = str(path).replace("//", "/")
    return normalize_remote_path(value)


def parse_cookie_text(raw: str) -> dict[str, str]:
    text = (raw or "").strip()
    if not text:
        raise ValueError("cookie is empty")
    found: dict[str, str] = {}
    for key, value in re.findall(r"(?:^|;\s*)(UID|CID|SEID|KID)=([^;]+)", text):
        found[key] = value.strip()
    missing = [key for key in ("UID", "CID", "SEID", "KID") if key not in found]
    if missing:
        raise ValueError(f"missing cookie keys: {', '.join(missing)}")
    return found


def load_auth() -> dict[str, str] | None:
    if AUTH_FILE.exists():
        with AUTH_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if all(data.get(key) for key in ("UID", "CID", "SEID", "KID")):
            return {key: str(data[key]) for key in ("UID", "CID", "SEID", "KID")}
    cookie = os.environ.get("115_COOKIE") or os.environ.get("COOKIE")
    if cookie:
        return parse_cookie_text(cookie)
    return None


def save_auth(cookie_values: dict[str, str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with AUTH_FILE.open("w", encoding="utf-8") as fh:
        json.dump(cookie_values, fh, ensure_ascii=False, indent=2)


def clear_auth() -> None:
    if AUTH_FILE.exists():
        AUTH_FILE.unlink()


def build_client():
    auth = load_auth()
    if not auth:
        raise RuntimeError("not authenticated")
    from cli115.auth import CookieAuth
    from cli115.client import create_client

    return create_client(
        CookieAuth(
            uid=auth["UID"],
            cid=auth["CID"],
            seid=auth["SEID"],
            kid=auth["KID"],
        )
    )


def fmt_bytes(value: int | None) -> str:
    if value is None:
        return ""
    size = float(value)
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{value}B"


def fmt_dt(value: datetime | None) -> str:
    return value.isoformat(timespec="seconds") if value else ""


def serialize_entry(entry) -> dict:
    data = {
        "id": entry.id,
        "parent_id": entry.parent_id,
        "name": entry.name,
        "path": entry.path or "",
        "is_directory": bool(entry.is_directory),
        "created_time": fmt_dt(entry.created_time),
        "modified_time": fmt_dt(entry.modified_time),
        "open_time": fmt_dt(entry.open_time),
        "labels": list(getattr(entry, "labels", [])),
    }
    if entry.is_directory:
        data["file_count"] = getattr(entry, "file_count", 0)
    else:
        data.update(
            {
                "size": int(getattr(entry, "size", 0)),
                "size_text": fmt_bytes(int(getattr(entry, "size", 0))),
                "sha1": getattr(entry, "sha1", ""),
                "file_type": getattr(entry, "file_type", ""),
                "pickcode": getattr(entry, "pickcode", ""),
                "starred": bool(getattr(entry, "starred", False)),
            }
        )
    return data


def get_client_page(path: str, sort: str, order: str, limit: int, offset: int):
    client = build_client()
    from cli115.client import SortField, SortOrder

    sort_field = SortField
    sort_order = SortOrder
    field = getattr(sort_field, SORT_FIELD_MAP.get(sort, "FILENAME"))
    direction = getattr(sort_order, "ASC" if order != "desc" else "DESC")
    path = normalize_remote_path(path)
    if hasattr(client.file, "_list"):
        items, pagination = client.file._list(  # type: ignore[attr-defined]
            path,
            sort=field,
            sort_order=direction,
            limit=limit,
            offset=offset,
        )
        return [serialize_entry(item) for item in items], {
            "total": pagination.total,
            "offset": pagination.offset,
            "limit": pagination.limit,
        }
    items = list(client.file.list(path, sort=field, sort_order=direction))
    slice_items = items[offset : offset + limit]
    return [serialize_entry(item) for item in slice_items], {
        "total": len(items),
        "offset": offset,
        "limit": limit,
    }


def search_entries(query: str, path: str | None, limit: int, offset: int):
    client = build_client()
    scope = normalize_remote_path(path) if path else None
    if hasattr(client.file, "_find"):
        items, pagination = client.file._find(  # type: ignore[attr-defined]
            query,
            path=scope,
            limit=limit,
            offset=offset,
        )
        return [serialize_entry(item) for item in items], {
            "total": pagination.total,
            "offset": pagination.offset,
            "limit": pagination.limit,
        }
    items = list(client.file.find(query, path=scope))
    slice_items = items[offset : offset + limit]
    return [serialize_entry(item) for item in slice_items], {
        "total": len(items),
        "offset": offset,
        "limit": limit,
    }


def ensure_remote_parent(client, remote_path: str) -> None:
    parent = posixpath.dirname(normalize_remote_path(remote_path))
    if parent and parent != "/":
        client.file.create_directory(parent, parents=True)


@APP.get("/")
def index():
    response.content_type = "text/html; charset=utf-8"
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@APP.get("/static/<filename:path>")
def assets(filename: str):
    return static_file(filename, root=str(STATIC_DIR))


@APP.get("/api/status")
def api_status():
    auth = load_auth()
    return json_response({"ok": True, "authenticated": bool(auth)})


@APP.post("/api/auth")
def api_auth():
    payload = request.json if isinstance(request.json, dict) else dict(request.forms)
    cookie_text = (payload.get("cookie") or "").strip()
    try:
        cookie_values = parse_cookie_text(cookie_text)
        save_auth(cookie_values)
        return json_response({"ok": True})
    except ValueError as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.post("/api/logout")
def api_logout():
    clear_auth()
    return json_response({"ok": True})


@APP.get("/api/account")
def api_account():
    try:
        client = build_client()
        info = client.account.info()
        usage = client.account.usage()
        return json_response(
            {
                "ok": True,
                "account": {
                    "user_name": info.user_name,
                    "user_id": info.user_id,
                    "vip": info.vip,
                    "expire": fmt_dt(info.expire),
                },
                "usage": {
                    "total": usage.total,
                    "used": usage.used,
                    "remaining": usage.remaining,
                    "used_text": fmt_bytes(usage.used),
                    "total_text": fmt_bytes(usage.total),
                },
            }
        )
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.get("/api/entries")
def api_entries():
    try:
        path = request.query.get("path", "/")
        sort = request.query.get("sort", "name")
        order = request.query.get("order", "asc")
        limit = int(request.query.get("limit", "500"))
        offset = int(request.query.get("offset", "0"))
        items, pagination = get_client_page(path, sort, order, limit, offset)
        return json_response({"ok": True, "path": normalize_remote_path(path), "items": items, "pagination": pagination})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.get("/api/search")
def api_search():
    try:
        query = request.query.get("q", "").strip()
        if not query:
            return json_response({"ok": False, "error": "query is required"}, status=400)
        path = request.query.get("path") or None
        limit = int(request.query.get("limit", "500"))
        offset = int(request.query.get("offset", "0"))
        items, pagination = search_entries(query, path, limit, offset)
        return json_response({"ok": True, "query": query, "items": items, "pagination": pagination})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.post("/api/mkdir")
def api_mkdir():
    try:
        payload = request.json if isinstance(request.json, dict) else dict(request.forms)
        path = normalize_remote_path(payload.get("path", "/"))
        name = (payload.get("name") or "").strip()
        if not name:
            return json_response({"ok": False, "error": "folder name is required"}, status=400)
        client = build_client()
        remote = join_remote_path(path, name)
        client.file.create_directory(remote, parents=True)
        return json_response({"ok": True, "path": remote})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.post("/api/rename")
def api_rename():
    try:
        payload = request.json if isinstance(request.json, dict) else dict(request.forms)
        path = normalize_remote_path(payload.get("path", "/"))
        name = (payload.get("name") or "").strip()
        if not name:
            return json_response({"ok": False, "error": "new name is required"}, status=400)
        client = build_client()
        client.file.rename(path, name)
        return json_response({"ok": True})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.post("/api/delete")
def api_delete():
    try:
        payload = request.json if isinstance(request.json, dict) else dict(request.forms)
        path = normalize_remote_path(payload.get("path", "/"))
        recursive = str(payload.get("recursive", "false")).lower() in {"1", "true", "yes", "on"}
        client = build_client()
        client.file.delete(path, recursive=recursive)
        return json_response({"ok": True})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.get("/api/direct-url")
def api_direct_url():
    try:
        path = normalize_remote_path(request.query.get("path", "/"))
        client = build_client()
        info = client.file.url(path)
        return json_response({"ok": True, "url": info.url, "file_name": info.file_name})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


@APP.get("/api/download")
def api_download():
    path = normalize_remote_path(request.query.get("path", "/"))
    client = build_client()
    info = client.file.url(path)

    def stream():
        headers = {
            "User-Agent": info.user_agent,
            "Cookie": info.cookies,
            "Referer": info.referer,
        }
        with httpx.Client(follow_redirects=True, timeout=None) as http:
            with http.stream("GET", info.url, headers=headers) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_bytes(1024 * 1024):
                    if chunk:
                        yield chunk

    response.set_header("Content-Disposition", f'attachment; filename="{info.file_name}"')
    response.content_type = "application/octet-stream"
    return stream()


@APP.post("/api/upload")
def api_upload():
    try:
        dest_path = normalize_remote_path((request.forms.get("dest_path") or "/").strip())
        uploads = request.files.getall("files")
        if not uploads:
            return json_response({"ok": False, "error": "no files selected"}, status=400)
        client = build_client()
        results = []
        for upload in uploads:
            rel = PurePosixPath(upload.filename)
            remote = join_remote_path(dest_path, str(rel))
            ensure_remote_parent(client, remote)
            uploaded = client.file.upload(remote, upload.file)
            results.append(serialize_entry(uploaded))
        return json_response({"ok": True, "items": results})
    except Exception as exc:
        return json_response({"ok": False, "error": str(exc)}, status=400)


def main():
    run(APP, host="0.0.0.0", port=int(os.environ.get("PORT", "7200")), quiet=True)


if __name__ == "__main__":
    main()
