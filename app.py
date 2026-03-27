import os
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

app = Flask(__name__)
port = int(os.getenv("PORT", 5050))
DATABASE_PATH = os.path.join(app.root_path, "waitwatcher.db")
PACIFIC_TZ = ZoneInfo("America/Los_Angeles")
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key-change-me")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,
)


MARKER_MAX_AGE = timedelta(hours=3)

TIERS = [
    (0,   "Newcomer"),
    (1,   "Scout"),
    (5,   "Spotter"),
    (15,  "Tracker"),
    (30,  "Ranger"),
    (75,  "Pathfinder"),
    (150, "Legend"),
]


def get_tier(total):
    """Return the highest tier name the user qualifies for."""
    tier = "Newcomer"
    for min_count, name in TIERS:
        if total >= min_count:
            tier = name
    return tier


def cleanup_expired_markers(connection):
    """Delete markers older than MARKER_MAX_AGE. Uses updated_at if set, otherwise submitted_at."""
    cutoff = datetime.now(timezone.utc) - MARKER_MAX_AGE
    rows = connection.execute("SELECT id, submitted_at, updated_at FROM markers").fetchall()
    expired = []
    for row in rows:
        try:
            raw = row["updated_at"] or row["submitted_at"]
            ts = datetime.fromisoformat(raw)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts < cutoff:
                expired.append(row["id"])
        except (ValueError, TypeError):
            continue
    if expired:
        connection.execute(
            f"DELETE FROM markers WHERE id IN ({','.join('?' * len(expired))})",
            expired,
        )
        connection.commit()


def get_db_connection():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db():
    connection = get_db_connection()
    cursor = connection.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS markers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            wait_time TEXT NOT NULL,
            notes TEXT,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            marker_id INTEGER NOT NULL REFERENCES markers(id) ON DELETE CASCADE,
            user_id   INTEGER NOT NULL REFERENCES users(id),
            vote      INTEGER NOT NULL CHECK(vote IN (1, -1)),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(marker_id, user_id)
        )
        """
    )

    marker_cols = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(markers)").fetchall()
    }
    if "created_by_username" not in marker_cols:
        connection.execute("ALTER TABLE markers ADD COLUMN created_by_username TEXT")
    if "user_id" not in marker_cols:
        connection.execute(
            "ALTER TABLE markers ADD COLUMN user_id INTEGER REFERENCES users(id)"
        )
    if "updated_at" not in marker_cols:
        connection.execute("ALTER TABLE markers ADD COLUMN updated_at TEXT")
    if "updated_by_username" not in marker_cols:
        connection.execute("ALTER TABLE markers ADD COLUMN updated_by_username TEXT")

    user_cols = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(users)").fetchall()
    }
    if "total_markers_created" not in user_cols:
        connection.execute(
            "ALTER TABLE users ADD COLUMN total_markers_created INTEGER NOT NULL DEFAULT 0"
        )
    if "total_karma" not in user_cols:
        connection.execute(
            "ALTER TABLE users ADD COLUMN total_karma INTEGER NOT NULL DEFAULT 0"
        )

    connection.commit()
    connection.close()


init_db()


@app.route("/")
def home():
    return render_template(
        "index.html",
        google_maps_api_key=os.getenv("GOOGLE_MAPS_API_KEY", "").strip(),
    )


@app.route("/profile/<username>")
def user_profile(username):
    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username, total_markers_created, total_karma FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    if not user:
        connection.close()
        abort(404)

    cleanup_expired_markers(connection)
    markers = connection.execute(
        """
        SELECT id, name, wait_time, notes, lat, lng, submitted_at,
               updated_at, updated_by_username,
               (SELECT COUNT(*) FROM votes WHERE marker_id = markers.id AND vote =  1) AS upvotes,
               (SELECT COUNT(*) FROM votes WHERE marker_id = markers.id AND vote = -1) AS downvotes
        FROM markers
        WHERE user_id = ?
        ORDER BY COALESCE(updated_at, submitted_at) DESC
        """,
        (user["id"],),
    ).fetchall()
    connection.close()

    total = user["total_markers_created"] or 0
    return render_template(
        "profile.html",
        profile_user={
            "username": user["username"],
            "tier": get_tier(total),
            "total_markers": total,
            "karma": user["total_karma"] or 0,
        },
        markers=[dict(m) for m in markers],
        marker_max_age_hours=int(MARKER_MAX_AGE.total_seconds() // 3600),
    )


@app.route("/api/markers", methods=["GET"])
def get_markers():
    uid = session.get("user_id") or 0
    connection = get_db_connection()
    cleanup_expired_markers(connection)
    rows = connection.execute(
        """
        SELECT m.id, m.name, m.wait_time, m.notes, m.lat, m.lng, m.submitted_at,
               m.created_by_username, m.user_id,
               m.updated_at, m.updated_by_username,
               COALESCE(u.total_markers_created, 0) AS creator_total,
               (SELECT COUNT(*) FROM votes WHERE marker_id = m.id AND vote =  1) AS upvotes,
               (SELECT COUNT(*) FROM votes WHERE marker_id = m.id AND vote = -1) AS downvotes,
               (SELECT vote    FROM votes WHERE marker_id = m.id AND user_id = ?) AS user_vote
        FROM markers m
        LEFT JOIN users u ON m.user_id = u.id
        ORDER BY m.submitted_at DESC
        LIMIT 200
        """,
        (uid,),
    ).fetchall()
    connection.close()

    markers = []
    for row in rows:
        d = dict(row)
        d["creator_tier"] = get_tier(d.pop("creator_total", 0) or 0)
        markers.append(d)
    return jsonify(markers), 200


@app.route("/api/markers", methods=["POST"])
def create_marker():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "unauthorized"}), 401

    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not user:
        connection.close()
        session.clear()
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    wait_time = str(payload.get("wait_time", "")).strip()
    notes = str(payload.get("notes", "")).strip()
    lat = payload.get("lat")
    lng = payload.get("lng")

    if not name or not wait_time:
        return jsonify({"error": "name and wait_time are required"}), 400

    try:
        lat = float(lat)
        lng = float(lng)
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng must be numeric"}), 400

    submitted_at = datetime.now(PACIFIC_TZ).isoformat(timespec="seconds")
    cursor = connection.cursor()
    cursor.execute(
        """
        INSERT INTO markers (name, wait_time, notes, lat, lng, submitted_at, created_by_username, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (name, wait_time, notes, lat, lng, submitted_at, user["username"], user_id),
    )
    marker_id = cursor.lastrowid
    connection.execute(
        "UPDATE users SET total_markers_created = total_markers_created + 1 WHERE id = ?",
        (user_id,),
    )
    connection.commit()

    row = connection.execute(
        """
        SELECT id, name, wait_time, notes, lat, lng, submitted_at,
               created_by_username, user_id, updated_at, updated_by_username
        FROM markers WHERE id = ?
        """,
        (marker_id,),
    ).fetchone()
    new_total = connection.execute(
        "SELECT total_markers_created FROM users WHERE id = ?", (user_id,)
    ).fetchone()["total_markers_created"] or 0
    connection.close()

    result = dict(row)
    result["creator_tier"] = get_tier(new_total)
    return jsonify(result), 201


@app.route("/api/markers/<int:marker_id>", methods=["DELETE"])
def delete_marker(marker_id):
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "unauthorized"}), 401

    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not user:
        connection.close()
        session.clear()
        return jsonify({"error": "unauthorized"}), 401

    marker = connection.execute(
        "SELECT * FROM markers WHERE id = ?", (marker_id,)
    ).fetchone()
    if not marker:
        connection.close()
        return jsonify({"error": "not found"}), 404

    if marker["user_id"] is not None:
        if marker["user_id"] != user_id:
            connection.close()
            return jsonify({"error": "forbidden"}), 403
    elif marker["created_by_username"] != user["username"]:
        connection.close()
        return jsonify({"error": "forbidden"}), 403

    connection.execute("DELETE FROM markers WHERE id = ?", (marker_id,))
    connection.commit()
    connection.close()

    return jsonify({"deleted": True}), 200


@app.route("/api/markers/<int:marker_id>", methods=["PATCH"])
def update_marker(marker_id):
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "unauthorized"}), 401

    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not user:
        connection.close()
        session.clear()
        return jsonify({"error": "unauthorized"}), 401

    marker = connection.execute(
        "SELECT id FROM markers WHERE id = ?", (marker_id,)
    ).fetchone()
    if not marker:
        connection.close()
        return jsonify({"error": "not found"}), 404

    payload = request.get_json(silent=True) or {}
    wait_time = str(payload.get("wait_time", "")).strip()
    if not wait_time:
        connection.close()
        return jsonify({"error": "wait_time is required"}), 400

    updated_at = datetime.now(PACIFIC_TZ).isoformat(timespec="seconds")
    connection.execute(
        "UPDATE markers SET wait_time = ?, updated_at = ?, updated_by_username = ? WHERE id = ?",
        (wait_time, updated_at, user["username"], marker_id),
    )
    connection.commit()

    row = connection.execute(
        """
        SELECT id, name, wait_time, notes, lat, lng, submitted_at,
               created_by_username, user_id, updated_at, updated_by_username
        FROM markers WHERE id = ?
        """,
        (marker_id,),
    ).fetchone()
    connection.close()

    return jsonify(dict(row)), 200


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"logged_in": False}), 200

    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username, email, total_markers_created, total_karma FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    connection.close()

    if not user:
        session.clear()
        return jsonify({"logged_in": False}), 200

    total = user["total_markers_created"] or 0
    return jsonify({
        "logged_in": True,
        "username": user["username"],
        "email": user["email"],
        "tier": get_tier(total),
        "total_markers": total,
        "karma": user["total_karma"] or 0,
    }), 200


@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    email = str(payload.get("email", "")).strip().lower()
    password = str(payload.get("password", "")).strip()

    if not username or not email or not password:
        return jsonify({"error": "username, email, and password are required"}), 400

    if len(password) < 6:
        return jsonify({"error": "password must be at least 6 characters"}), 400

    connection = get_db_connection()

    if connection.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        connection.close()
        return jsonify({"error": "email already in use"}), 409

    if connection.execute(
        "SELECT 1 FROM users WHERE username = ?", (username,)
    ).fetchone():
        connection.close()
        return jsonify({"error": "username already in use"}), 409

    password_hash = generate_password_hash(password)
    cursor = connection.cursor()
    cursor.execute(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        (username, email, password_hash),
    )
    user_id = cursor.lastrowid
    connection.commit()
    session["user_id"] = user_id

    user = connection.execute(
        "SELECT id, username, email FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    connection.close()

    return (
        jsonify({"logged_in": True, "username": user["username"], "email": user["email"]}),
        201,
    )


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", "")).strip()

    if not username or not password:
        return jsonify({"error": "username and password are required"}), 400

    connection = get_db_connection()
    user = connection.execute(
        "SELECT id, username, email, password_hash FROM users WHERE username = ?",
        (username,),
    ).fetchone()

    if not user or not check_password_hash(user["password_hash"], password):
        connection.close()
        return jsonify({"error": "invalid credentials"}), 401

    session["user_id"] = user["id"]
    connection.close()

    return (
        jsonify({"logged_in": True, "username": user["username"], "email": user["email"]}),
        200,
    )


@app.route("/api/markers/<int:marker_id>/vote", methods=["POST"])
def vote_marker(marker_id):
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    vote_value = payload.get("vote")
    if vote_value not in (1, -1):
        return jsonify({"error": "vote must be 1 or -1"}), 400

    connection = get_db_connection()

    marker = connection.execute(
        "SELECT id, user_id FROM markers WHERE id = ?", (marker_id,)
    ).fetchone()
    if not marker:
        connection.close()
        return jsonify({"error": "not found"}), 404

    if marker["user_id"] == user_id:
        connection.close()
        return jsonify({"error": "cannot vote on your own marker"}), 403

    existing = connection.execute(
        "SELECT vote FROM votes WHERE marker_id = ? AND user_id = ?",
        (marker_id, user_id),
    ).fetchone()

    creator_id = marker["user_id"]
    karma_delta = 0

    if existing is None:
        connection.execute(
            "INSERT INTO votes (marker_id, user_id, vote) VALUES (?, ?, ?)",
            (marker_id, user_id, vote_value),
        )
        karma_delta = vote_value
        returned_vote = vote_value
    elif existing["vote"] == vote_value:
        connection.execute(
            "DELETE FROM votes WHERE marker_id = ? AND user_id = ?",
            (marker_id, user_id),
        )
        karma_delta = -vote_value
        returned_vote = 0
    else:
        connection.execute(
            "UPDATE votes SET vote = ? WHERE marker_id = ? AND user_id = ?",
            (vote_value, marker_id, user_id),
        )
        karma_delta = vote_value - existing["vote"]
        returned_vote = vote_value

    if creator_id and karma_delta != 0:
        connection.execute(
            "UPDATE users SET total_karma = total_karma + ? WHERE id = ?",
            (karma_delta, creator_id),
        )

    connection.commit()

    upvotes = connection.execute(
        "SELECT COUNT(*) FROM votes WHERE marker_id = ? AND vote = 1", (marker_id,)
    ).fetchone()[0]
    downvotes = connection.execute(
        "SELECT COUNT(*) FROM votes WHERE marker_id = ? AND vote = -1", (marker_id,)
    ).fetchone()[0]
    connection.close()

    return jsonify({"upvotes": upvotes, "downvotes": downvotes, "user_vote": returned_vote}), 200


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"logged_in": False}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=port, debug=True)
