import io
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import app
import parsers_core


class BackendSecurityRegressionTests(unittest.TestCase):
    def test_ao3_work_url_requires_exact_host_and_work_path(self):
        self.assertEqual(
            app._canonical_ao3_work_url(
                "https://www.archiveofourown.org/works/123/chapters/456?view_adult=true"),
            "https://archiveofourown.org/works/123",
        )
        self.assertIsNone(app._canonical_ao3_work_url(
            "https://archiveofourown.org.evil.example/works/123"))
        self.assertIsNone(app._canonical_ao3_work_url(
            "https://example.com/?next=archiveofourown.org/works/123"))

    def test_push_endpoint_requires_known_relay(self):
        self.assertTrue(app._is_allowed_push_endpoint(
            "https://fcm.googleapis.com/fcm/send/abc"))
        self.assertTrue(app._is_allowed_push_endpoint(
            "https://web.push.apple.com/Qabc"))
        self.assertFalse(app._is_allowed_push_endpoint(
            "https://attacker.example/collect"))
        self.assertFalse(app._is_allowed_push_endpoint(
            "https://fcm.googleapis.com:444/fcm/send/abc"))

    def test_zip_member_count_guard(self):
        old_limit = parsers_core.MAX_ZIP_MEMBERS
        parsers_core.MAX_ZIP_MEMBERS = 2
        try:
            with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as handle:
                path = handle.name
            with zipfile.ZipFile(path, "w") as archive:
                for index in range(3):
                    archive.writestr(f"{index}.txt", "x")
            with self.assertRaisesRegex(ValueError, "too many files"):
                parsers_core.guard_zip_bomb(path)
        finally:
            parsers_core.MAX_ZIP_MEMBERS = old_limit
            os.unlink(path)


class PushCleanupRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_cleanup_deletes_subscription_and_state_together(self):
        connection = await app.init_db_async(":memory:")
        old_connection = app._db_conn
        app._db_conn = connection
        try:
            await connection.execute(
                "INSERT INTO subscriptions "
                "(user_id, subscription_json, created_at, auth_token_hash) "
                "VALUES (?, ?, 0, ?)",
                ("owner", "{}", "hash"),
            )
            await connection.execute(
                "INSERT INTO user_state "
                "(user_id, profile_json, updated_at, size_bytes) "
                "VALUES (?, ?, 0, 2)",
                ("owner", "{}"),
            )
            await connection.commit()
            await app._delete_push_owner_data("owner")
            await connection.commit()
            for table in ("subscriptions", "user_state"):
                async with connection.execute(
                        f"SELECT COUNT(*) FROM {table} WHERE user_id = ?",
                        ("owner",)) as cursor:
                    self.assertEqual((await cursor.fetchone())[0], 0)
        finally:
            app._db_conn = old_connection
            await connection.close()


if __name__ == "__main__":
    unittest.main()
