import anvil.server
import anvil.tables
import anvil.users
from anvil import BlobMedia
from anvil.tables import app_tables

import base64
import hashlib
import json
import time
from datetime import datetime, timezone


PROFILE_SCHEMA_VERSION = 3
MAX_PROFILE_BYTES = 1024 * 1024
MAX_AVATAR_BYTES = 256 * 1024
MAX_HISTORY_ITEMS = 250
DEVICE_ONLY_SETTINGS = {
  "maxWorkers", "enableManualWorkers", "enableNvidiaWebGPU", "enableAMDWorkarounds", "_engineManuallySet",
  "lowMemoryMode", "cacheLimitMb", "storageBudgetMb", "pocketQualityMode",
  "dataSaver", "lastDeviceProfile", "diagnosticLevel",
}
STORY_FIELD_GROUPS = {
  "metadata": ("title", "author", "url", "sourceUrl", "source_url", "tags", "fandoms", "summary", "wordCount", "chapterCount", "cover", "publishedChapters", "declaredChapters", "updateSubscribed", "workComplete"),
  "progress": ("progressChapter", "progressParagraph", "isFinished", "lastRead"),
  "favorite": ("favorite", "isFavorite"),
  "rating": ("userRating",),
  "bookmarks": ("bookmarks",),
  "narration": ("narrationPreset",),
  "collections": ("collectionIds", "queueIndex"),
}
WITHDRAWN_TITLE_HASHES = {2097602949, 4010063105, 498652239, 3528427211}
WITHDRAWN_AUTHOR_HASHES = {1741912528}
WITHDRAWN_FILE_HASHES = {586215127, 4227966908}


def _now_ms():
  return int(time.time() * 1000)


def _as_int(value, default=0, minimum=None, maximum=None):
  try:
    number = int(value)
  except (TypeError, ValueError, OverflowError):
    number = int(default)
  if minimum is not None:
    number = max(minimum, number)
  if maximum is not None:
    number = min(maximum, number)
  return number


def _profile_hash(value):
  normalized = "".join(ch for ch in str(value or "").lower() if ch.isalnum())
  result = 5381
  for ch in normalized:
    result = (((result << 5) + result) ^ ord(ch)) & 0xFFFFFFFF
  return result


def _story_filename(value):
  raw = str(value or "").split("?", 1)[0].replace("\\", "/")
  return raw.rsplit("/", 1)[-1]


def _is_withdrawn(story):
  if not isinstance(story, dict):
    return False
  if _profile_hash(story.get("title")) in WITHDRAWN_TITLE_HASHES:
    return True
  if _profile_hash(story.get("author") or story.get("creator")) in WITHDRAWN_AUTHOR_HASHES:
    return True
  for key in ("url", "id", "sourceUrl", "source_url", "filename", "file"):
    if _profile_hash(_story_filename(story.get(key))) in WITHDRAWN_FILE_HASHES:
      return True
  return False


def _parse_profile(profile_data):
  parsed = profile_data
  for _ in range(2):
    if not isinstance(parsed, str):
      break
    raw = parsed.strip()
    if not raw:
      return {}
    if len(raw.encode("utf-8")) > MAX_PROFILE_BYTES:
      raise ValueError("Profile payload is too large")
    try:
      parsed = json.loads(raw)
    except Exception:
      raise ValueError("profile_data must be valid JSON")
  if parsed is None:
    return {}
  if not isinstance(parsed, dict):
    raise ValueError("profile_data must be a JSON object")
  return json.loads(json.dumps(parsed, ensure_ascii=False))


def _compact_size(value):
  return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _story_key(story):
  existing = str(story.get("storyKey") or "").strip()
  if existing:
    return existing[:200]
  source = story.get("sourceUrl") or story.get("source_url") or story.get("url") or story.get("id")
  source = source or "%s|%s" % (story.get("title", ""), story.get("author", ""))
  return "s_%s" % _profile_hash(source)


def _normalize_bookmarks(bookmarks):
  normalized = []
  for item in bookmarks if isinstance(bookmarks, list) else []:
    if not isinstance(item, dict):
      continue
    stamp = _as_int(item.get("updatedAt") or item.get("ts"), _now_ms(), minimum=0)
    bookmark = dict(item)
    bookmark["id"] = str(item.get("id") or "b_%s_%s_%s" % (item.get("c", 0), item.get("p", 0), stamp))
    bookmark["updatedAt"] = stamp
    normalized.append(bookmark)
  return normalized[-100:]


def _normalize_achievements(value):
  result = {}
  items = value if isinstance(value, list) else []
  for item in items:
    if isinstance(item, str):
      key = item
      result[key] = {"id": key, "unlockedAt": 0}
    elif isinstance(item, dict) and item.get("id"):
      key = str(item["id"])
      current = result.get(key)
      stamp = _as_int(item.get("unlockedAt"), 0, minimum=0)
      if current is None or stamp < _as_int(current.get("unlockedAt"), stamp, minimum=0):
        result[key] = {"id": key, "unlockedAt": stamp}
  return list(result.values())


def _normalize_profile(profile, device_id=None):
  value = _parse_profile(profile)
  value["schemaVersion"] = PROFILE_SCHEMA_VERSION
  value["revision"] = _as_int(value.get("revision"), 0, minimum=0, maximum=9007199254740991)
  value["updatedAt"] = _as_int(value.get("updatedAt"), _now_ms(), minimum=0)
  value["deviceId"] = str(device_id or value.get("deviceId") or "legacy")[:128]
  value.pop("avatar", None)
  value.pop("cloudEmail", None)
  value.pop("isLoggedIn", None)

  settings = value.get("settings") if isinstance(value.get("settings"), dict) else {}
  for key in DEVICE_ONLY_SETTINGS:
    settings.pop(key, None)
  settings.pop("siteCookies", None)
  value["settings"] = settings
  value["settingsFieldUpdatedAt"] = value.get("settingsFieldUpdatedAt") if isinstance(value.get("settingsFieldUpdatedAt"), dict) else {}
  value["profileFieldUpdatedAt"] = value.get("profileFieldUpdatedAt") if isinstance(value.get("profileFieldUpdatedAt"), dict) else {}
  value["deletedStoryKeys"] = value.get("deletedStoryKeys") if isinstance(value.get("deletedStoryKeys"), dict) else {}

  library = []
  for raw_story in value.get("library") if isinstance(value.get("library"), list) else []:
    if not isinstance(raw_story, dict) or _is_withdrawn(raw_story):
      continue
    story = dict(raw_story)
    for forbidden in ("chapters", "chapterText", "audio", "audioCache", "cacheDecision"):
      story.pop(forbidden, None)
    story["storyKey"] = _story_key(story)
    base_stamp = _as_int(story.get("updatedAt") or story.get("lastRead") or story.get("addedAt"), value["updatedAt"], minimum=0)
    sync = story.get("sync") if isinstance(story.get("sync"), dict) else {}
    for group in STORY_FIELD_GROUPS:
      sync[group] = _as_int(sync.get(group), base_stamp, minimum=0)
    story["sync"] = sync
    story["bookmarks"] = _normalize_bookmarks(story.get("bookmarks"))
    story["updatedAt"] = max(sync.values()) if sync else base_stamp
    library.append(story)
  value["library"] = library
  value["achievements"] = _normalize_achievements(value.get("achievements"))
  value["statsByDevice"] = value.get("statsByDevice") if isinstance(value.get("statsByDevice"), dict) else {}
  value["dailyStatsByDevice"] = value.get("dailyStatsByDevice") if isinstance(value.get("dailyStatsByDevice"), dict) else {}
  if not value["statsByDevice"] and isinstance(value.get("stats"), dict):
    value["statsByDevice"][value["deviceId"]] = dict(value["stats"])
  value["activityDays"] = sorted(set(str(day) for day in (value.get("activityDays") or []) if day))[-800:]
  value["collections"] = value.get("collections") if isinstance(value.get("collections"), list) else []
  value["history"] = value.get("history") if isinstance(value.get("history"), list) else []
  value["readingQueue"] = value.get("readingQueue") if isinstance(value.get("readingQueue"), list) else []
  value["readingQueueUpdatedAt"] = _as_int(value.get("readingQueueUpdatedAt"), value["updatedAt"], minimum=0)
  value["goals"] = value.get("goals") if isinstance(value.get("goals"), dict) else {}
  if _compact_size(value) > MAX_PROFILE_BYTES:
    raise ValueError("Profile payload is too large")
  return value


def _merge_clocked_map(cloud_values, incoming_values, cloud_clocks, incoming_clocks):
  values = dict(cloud_values or {})
  clocks = dict(cloud_clocks or {})
  for key, incoming_value in (incoming_values or {}).items():
    incoming_stamp = _as_int((incoming_clocks or {}).get(key), 0, minimum=0)
    if incoming_stamp >= _as_int(clocks.get(key), 0, minimum=0):
      values[key] = incoming_value
      clocks[key] = incoming_stamp
  return values, clocks


def _merge_bookmarks(cloud_items, incoming_items):
  merged = {item["id"]: dict(item) for item in _normalize_bookmarks(cloud_items)}
  for item in _normalize_bookmarks(incoming_items):
    current = merged.get(item["id"])
    if current is None or _as_int(item.get("updatedAt"), 0, minimum=0) >= _as_int(current.get("updatedAt"), 0, minimum=0):
      merged[item["id"]] = dict(item)
  return sorted(merged.values(), key=lambda item: _as_int(item.get("updatedAt"), 0, minimum=0))[-100:]


def _merge_story(cloud_story, incoming_story):
  result = dict(cloud_story or {})
  cloud_sync = dict((cloud_story or {}).get("sync") or {})
  incoming_sync = dict((incoming_story or {}).get("sync") or {})
  for group, fields in STORY_FIELD_GROUPS.items():
    cloud_stamp = _as_int(cloud_sync.get(group), 0, minimum=0)
    incoming_stamp = _as_int(incoming_sync.get(group), 0, minimum=0)
    if incoming_stamp >= cloud_stamp:
      if group == "bookmarks":
        result["bookmarks"] = _merge_bookmarks(result.get("bookmarks"), incoming_story.get("bookmarks"))
      else:
        for field in fields:
          if field in incoming_story:
            result[field] = incoming_story[field]
      cloud_sync[group] = incoming_stamp
  result["storyKey"] = incoming_story.get("storyKey") or cloud_story.get("storyKey")
  result["sync"] = cloud_sync
  result["updatedAt"] = max(cloud_sync.values()) if cloud_sync else _now_ms()
  return result


def _merge_profile(cloud_profile, incoming_profile, device_id):
  cloud = _normalize_profile(cloud_profile or {}, device_id)
  incoming = _normalize_profile(incoming_profile or {}, device_id)
  result = dict(cloud)

  profile_fields = ("displayName", "userCategory", "favoriteGenre", "favoriteFandom", "favoriteCharacter", "preferredLength", "readingMood", "currentlyReading", "favoriteStories", "companion")
  cloud_profile_values = {key: cloud.get(key) for key in profile_fields if key in cloud}
  incoming_profile_values = {key: incoming.get(key) for key in profile_fields if key in incoming}
  merged_values, profile_clocks = _merge_clocked_map(cloud_profile_values, incoming_profile_values, cloud.get("profileFieldUpdatedAt"), incoming.get("profileFieldUpdatedAt"))
  result.update(merged_values)
  result["profileFieldUpdatedAt"] = profile_clocks
  result["settings"], result["settingsFieldUpdatedAt"] = _merge_clocked_map(cloud.get("settings"), incoming.get("settings"), cloud.get("settingsFieldUpdatedAt"), incoming.get("settingsFieldUpdatedAt"))

  deleted = dict(cloud.get("deletedStoryKeys") or {})
  for key, stamp in (incoming.get("deletedStoryKeys") or {}).items():
    deleted[key] = max(_as_int(stamp, 0, minimum=0), _as_int(deleted.get(key), 0, minimum=0))
  result["deletedStoryKeys"] = deleted
  stories = {story["storyKey"]: story for story in cloud.get("library", [])}
  for story in incoming.get("library", []):
    key = story["storyKey"]
    delete_stamp = _as_int(deleted.get(key), 0, minimum=0)
    if delete_stamp >= _as_int(story.get("updatedAt"), 0, minimum=0):
      stories.pop(key, None)
      continue
    stories[key] = _merge_story(stories.get(key, {}), story)
  result["library"] = [story for key, story in stories.items() if _as_int(deleted.get(key), 0, minimum=0) < _as_int(story.get("updatedAt"), 0, minimum=0) and not _is_withdrawn(story)]

  achievements = {}
  for item in cloud.get("achievements", []) + incoming.get("achievements", []):
    key = item["id"]
    stamp = _as_int(item.get("unlockedAt"), 0, minimum=0)
    if key not in achievements or stamp < _as_int(achievements[key].get("unlockedAt"), stamp, minimum=0):
      achievements[key] = dict(item)
  result["achievements"] = list(achievements.values())

  stats_by_device = {}
  for source in (cloud.get("statsByDevice", {}), incoming.get("statsByDevice", {})):
    for source_device, counters in source.items():
      target = stats_by_device.setdefault(str(source_device), {})
      if isinstance(counters, dict):
        for key, value in counters.items():
          if isinstance(value, (int, float)):
            target[key] = max(value, target.get(key, 0))
  result["statsByDevice"] = stats_by_device
  daily_by_device = {}
  for source in (cloud.get("dailyStatsByDevice", {}), incoming.get("dailyStatsByDevice", {})):
    if not isinstance(source, dict):
      continue
    for source_device, days in source.items():
      if not isinstance(days, dict):
        continue
      target_days = daily_by_device.setdefault(str(source_device), {})
      for day, counters in days.items():
        if not isinstance(counters, dict):
          continue
        target = target_days.setdefault(str(day)[:10], {})
        for key, value in counters.items():
          if isinstance(value, (int, float)):
            target[key] = max(value, target.get(key, 0))
      for old_day in sorted(target_days)[:-400]:
        target_days.pop(old_day, None)
  result["dailyStatsByDevice"] = daily_by_device
  result["activityDays"] = sorted(set(cloud.get("activityDays", []) + incoming.get("activityDays", [])))[-800:]
  aggregate = {}
  max_keys = ("streak", "speedAdjusted", "first", "curatedAuthor", "daysSinceFirst")
  for counters in stats_by_device.values():
    for key, value in counters.items():
      if not isinstance(value, (int, float)):
        continue
      if key.lower().startswith(tuple(item.lower() for item in max_keys)):
        aggregate[key] = max(value, aggregate.get(key, 0))
      else:
        aggregate[key] = aggregate.get(key, 0) + value
  aggregate["favorites"] = len([story for story in result["library"] if story.get("favorite") or story.get("isFavorite")])
  aggregate["unread"] = len([story for story in result["library"] if not story.get("progressChapter") and not story.get("progressParagraph") and not story.get("isFinished")])
  aggregate["hoursListened"] = float(aggregate.get("totalWords", 0)) / 9000.0
  aggregate["distinctDays"] = len(result["activityDays"])
  result["stats"] = aggregate

  for list_name, identity in (("collections", "id"), ("history", "id")):
    merged = {}
    for item in cloud.get(list_name, []) + incoming.get(list_name, []):
      if not isinstance(item, dict):
        continue
      item_id = str(item.get(identity) or "")
      if not item_id:
        continue
      current = merged.get(item_id)
      if current is None or _as_int(item.get("updatedAt") or item.get("lastAt"), 0, minimum=0) >= _as_int(current.get("updatedAt") or current.get("lastAt"), 0, minimum=0):
        merged[item_id] = dict(item)
    values = [item for item in merged.values() if not item.get("deletedAt")]
    result[list_name] = values[-MAX_HISTORY_ITEMS:] if list_name == "history" else values

  if _as_int(incoming.get("readingQueueUpdatedAt"), 0, minimum=0) >= _as_int(cloud.get("readingQueueUpdatedAt"), 0, minimum=0):
    result["readingQueue"] = list(dict.fromkeys(str(key) for key in incoming.get("readingQueue", []) if key))[:500]
    result["readingQueueUpdatedAt"] = _as_int(incoming.get("readingQueueUpdatedAt"), 0, minimum=0)
  else:
    result["readingQueue"] = cloud.get("readingQueue", [])
    result["readingQueueUpdatedAt"] = _as_int(cloud.get("readingQueueUpdatedAt"), 0, minimum=0)

  result["goals"] = incoming.get("goals") if _as_int(incoming.get("goals", {}).get("updatedAt"), 0, minimum=0) >= _as_int(cloud.get("goals", {}).get("updatedAt"), 0, minimum=0) else cloud.get("goals", {})
  result["schemaVersion"] = PROFILE_SCHEMA_VERSION
  result["deviceId"] = str(device_id or incoming.get("deviceId") or "legacy")[:128]
  result["updatedAt"] = _now_ms()
  return _normalize_profile(result, result["deviceId"])


def _get_profile_row(user):
  return app_tables.user_profiles.get(user=user)


def _row_profile(row):
  if not row:
    return {}
  try:
    return _parse_profile(row["profile_data"])
  except Exception:
    return {}


def _row_revision(row, profile):
  try:
    return int(row["revision"] or 0)
  except Exception:
    return int(profile.get("revision") or 0)


def _migrate_legacy_avatar(row, profile):
  if not row or not isinstance(profile, dict) or not profile.get("avatarData"):
    return profile
  try:
    content_type, raw = _decode_avatar(profile["avatarData"])
    row["avatar_media"] = BlobMedia(content_type, raw, name="profile-avatar.webp")
    row["avatar_hash"] = hashlib.sha256(raw).hexdigest()
    migrated = dict(profile)
    migrated.pop("avatarData", None)
    migrated.pop("avatarHash", None)
    row["profile_data"] = migrated
    return migrated
  except Exception:
    return profile


def _save_row(user, row, profile, revision):
  profile["revision"] = revision
  now = datetime.now(timezone.utc)
  if row:
    row["profile_data"] = profile
    try:
      row["revision"] = revision
      row["updated_at"] = now
    except Exception:
      pass
  else:
    values = {"user": user, "profile_data": profile}
    try:
      values.update({"revision": revision, "updated_at": now})
      app_tables.user_profiles.add_row(**values)
    except Exception:
      app_tables.user_profiles.add_row(user=user, profile_data=profile)


@anvil.server.callable
@anvil.tables.in_transaction
def sync_user_profile(profile_data, base_revision=0, device_id=None):
  user = anvil.users.get_user()
  if not user:
    raise Exception("You must be logged in to sync your profile.")
  incoming = _normalize_profile(profile_data, device_id)
  try:
    requested_base = max(0, int(base_revision or 0))
  except Exception:
    raise ValueError("base_revision must be an integer")
  if requested_base > 9007199254740991:
    raise ValueError("base_revision is outside the supported range")

  row = _get_profile_row(user)
  cloud = _migrate_legacy_avatar(row, _row_profile(row))
  revision = _row_revision(row, cloud) + 1
  merged = _merge_profile(cloud, incoming, device_id)
  _save_row(user, row, merged, revision)
  return {"profile": _normalize_profile(merged, device_id), "revision": revision, "syncedAt": _now_ms()}


@anvil.server.callable
def save_user_profile(profile_data):
  result = sync_user_profile(profile_data, 0, None)
  return bool(result)


@anvil.server.callable
@anvil.tables.in_transaction
def load_user_profile():
  user = anvil.users.get_user()
  if not user:
    return None
  row = _get_profile_row(user)
  profile = _normalize_profile(_migrate_legacy_avatar(row, _row_profile(row)), "legacy") if row else None
  if profile and isinstance(row["profile_data"], str):
    _save_row(user, row, profile, _row_revision(row, profile))
  return profile


def _decode_avatar(data_url):
  if not isinstance(data_url, str) or "," not in data_url:
    raise ValueError("Avatar must be an image data URL")
  header, payload = data_url.split(",", 1)
  content_type = header.split(";", 1)[0].replace("data:", "").lower()
  if content_type not in ("image/webp", "image/png", "image/jpeg"):
    raise ValueError("Avatar must be WebP, PNG, or JPEG")
  try:
    raw = base64.b64decode(payload, validate=True)
  except Exception:
    raise ValueError("Avatar data is invalid")
  if len(raw) > MAX_AVATAR_BYTES:
    raise ValueError("Avatar is too large")
  return content_type, raw


@anvil.server.callable
@anvil.tables.in_transaction
def save_user_avatar(data_url):
  user = anvil.users.get_user()
  if not user:
    raise Exception("You must be logged in to sync your avatar.")
  content_type, raw = _decode_avatar(data_url)
  row = _get_profile_row(user)
  if not row:
    profile = _normalize_profile({}, "legacy")
    _save_row(user, None, profile, 1)
    row = _get_profile_row(user)
  digest = hashlib.sha256(raw).hexdigest()
  try:
    row["avatar_media"] = BlobMedia(content_type, raw, name="profile-avatar.webp")
    row["avatar_hash"] = digest
  except Exception:
    profile = _row_profile(row)
    profile["avatarData"] = data_url
    profile["avatarHash"] = digest
    row["profile_data"] = profile
  return {"hash": digest, "bytes": len(raw)}


@anvil.server.callable
def load_user_avatar():
  user = anvil.users.get_user()
  if not user:
    return None
  row = _get_profile_row(user)
  if not row:
    return None
  try:
    media = row["avatar_media"]
    if media:
      raw = media.get_bytes()
      content_type = media.content_type or "image/webp"
      return "data:%s;base64,%s" % (content_type, base64.b64encode(raw).decode("ascii"))
  except Exception:
    pass
  return _row_profile(row).get("avatarData")


@anvil.server.callable
@anvil.tables.in_transaction
def delete_user_account_data(confirmation):
  user = anvil.users.get_user()
  if not user:
    raise Exception("You must be logged in.")
  email = str(user["email"] or "").strip().lower()
  if str(confirmation or "").strip().lower() != email:
    raise ValueError("Enter the account email to confirm deletion.")
  row = _get_profile_row(user)
  if row:
    row.delete()
  user.delete()
  return True


@anvil.server.http_endpoint("/api/login", methods=["POST"], authenticate_users=True)
def api_login(**_params):
  user = anvil.users.get_user()
  row = _get_profile_row(user)
  return {"status": "success", "email": user["email"], "profile_data": _row_profile(row)}


@anvil.server.http_endpoint("/api/sync", methods=["POST", "GET"], authenticate_users=True)
def api_sync(**kwargs):
  user = anvil.users.get_user()
  row = _get_profile_row(user)
  if anvil.server.request.method == "GET":
    return {"profile_data": _row_profile(row), "revision": _row_revision(row, _row_profile(row))}
  body = anvil.server.request.body_json or {}
  if not isinstance(body, dict) or "profile_data" not in body:
    return anvil.server.HttpResponse(400, {"error": "Missing profile_data payload"})
  try:
    result = sync_user_profile(body.get("profile_data"), body.get("base_revision", 0), body.get("device_id"))
  except ValueError as exc:
    return anvil.server.HttpResponse(400, {"error": str(exc)})
  return {"status": "success", **result}
