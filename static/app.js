"use strict";

// ─── Config ─────────────────────────────────────────────────────────────────
const PACIFIC_TZ = "America/Los_Angeles";
const TIER_DEFS = [
    { min: 0,   name: "Newcomer"   },
    { min: 1,   name: "Scout"      },
    { min: 5,   name: "Spotter"    },
    { min: 15,  name: "Tracker"    },
    { min: 30,  name: "Ranger"     },
    { min: 75,  name: "Pathfinder" },
    { min: 150, name: "Legend"     },
];
const STALE_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MARKER_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours — must match backend
const REFRESH_MS = 60 * 1000;           // 60 seconds
const CPP = [34.056, -117.821];
const appConfig = window.WAITWATCHER_CONFIG || {};

// ─── State ──────────────────────────────────────────────────────────────────
const markerRegistry = new Map(); // id -> { leafletMarker, data }
let userMarker = null;
let currentUser = null;
let placeMode = false;
let activeFormPopup = null;
let _loadMeSeq = 0; // version counter — prevents stale loadMe() from overwriting newer auth state

// ─── Map setup ──────────────────────────────────────────────────────────────
const map = L.map("map").setView(CPP, 14);
const hasGoogle = Boolean(window.google && appConfig.googleMapsApiKey);

if (hasGoogle) {
    const streets = L.gridLayer.googleMutant({ type: "roadmap", maxZoom: 21 }).addTo(map);
    L.control.layers(
        {
            "Streets": streets,
            "Hybrid": L.gridLayer.googleMutant({ type: "hybrid", maxZoom: 21 }),
            "Satellite": L.gridLayer.googleMutant({ type: "satellite", maxZoom: 21 }),
        },
        {},
        { position: "topright", collapsed: true }
    ).addTo(map);
} else {
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }).addTo(map);
}

L.Control.geocoder({ defaultMarkGeocode: false, placeholder: "Search places…" })
    .on("markgeocode", (e) => map.flyTo(e.geocode.center, 16, { duration: 0.6 }))
    .addTo(map);

// ─── Utilities ──────────────────────────────────────────────────────────────
function setStatus(msg) {
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
}

function escapeHtml(v) {
    return String(v)
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function parseDate(v) {
    if (!v) return null;
    return new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z");
}

function timeAgo(v) {
    const d = parseDate(v);
    if (!d || isNaN(d)) return "";
    const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

function formatDateTime(v) {
    const d = parseDate(v);
    if (!d || isNaN(d)) return "Unknown";
    return new Intl.DateTimeFormat("en-US", {
        timeZone: PACIFIC_TZ,
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    }).format(d);
}

function isStale(v) {
    const d = parseDate(v);
    return d ? Date.now() - d.getTime() > STALE_MS : false;
}

function msUntilExpiry(marker) {
    const effectiveTs = marker.updated_at || marker.submitted_at;
    const d = parseDate(effectiveTs);
    if (!d) return 0;
    return d.getTime() + MARKER_MAX_AGE_MS - Date.now();
}

function formatExpiry(ms) {
    if (ms <= 0) return "expired";
    const totalMin = Math.ceil(ms / 60000);
    if (totalMin < 1) return "< 1m left";
    if (totalMin < 60) return `${totalMin}m left`;
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    return min > 0 ? `${hr}h ${min}m left` : `${hr}h left`;
}

// ─── Wait time categorization ────────────────────────────────────────────────
function categorizeWait(str) {
    const s = String(str || "").toLowerCase().trim();
    if (!s || s === "no wait" || s === "none" || s === "0") return "none";
    const hrMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
    const minMatch = s.match(/(\d+)\s*m/);
    let minutes = 0;
    if (hrMatch) minutes += parseFloat(hrMatch[1]) * 60;
    if (minMatch) minutes += parseInt(minMatch[1], 10);
    if (!minutes && /^\d+$/.test(s)) minutes = parseInt(s, 10);
    if (!minutes) return "unknown";
    if (minutes <= 10) return "low";
    if (minutes <= 25) return "medium";
    return "high";
}

// ─── Marker icons ────────────────────────────────────────────────────────────
function createMarkerIcon(category, stale) {
    const cls = ["ww-pin-wrapper", `cat-${category}`, stale ? "ww-stale" : ""].filter(Boolean).join(" ");
    return L.divIcon({
        className: cls,
        html: `<svg class="ww-pin" width="28" height="36" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path class="ww-pin-body" d="M14 1C7.37 1 2 6.37 2 13C2 21.5 14 35 14 35C14 35 26 21.5 26 13C26 6.37 20.63 1 14 1Z"/><circle cx="14" cy="13" r="5" class="ww-pin-center"/></svg>`,
        iconSize: [28, 36],
        iconAnchor: [14, 35],
        popupAnchor: [0, -38],
    });
}

// ─── Popup content ───────────────────────────────────────────────────────────
function tierBadge(tier) {
    if (!tier) return "";
    return `<span class="tier-badge tier--${tier.toLowerCase()}" title="${escapeHtml(tier)}">${escapeHtml(tier)}</span>`;
}

function buildPopupContent(marker) {
    const category = categorizeWait(marker.wait_time);
    const stale = isStale(marker.submitted_at);
    const age = timeAgo(marker.submitted_at);
    const byRaw = marker.created_by_username;
    const by = byRaw
        ? `<a class="username-link" href="/profile/${encodeURIComponent(byRaw)}" target="_blank">${escapeHtml(byRaw)}</a>`
        : "Anonymous";
    const badge = tierBadge(marker.creator_tier);
    const isOwner = currentUser && currentUser.username === marker.created_by_username;
    const expiryMs = msUntilExpiry(marker);
    const expiryCls = expiryMs < 30 * 60 * 1000 ? " expiry-soon" : "";
    const expiryText = formatExpiry(expiryMs);
    const upvotes = marker.upvotes || 0;
    const downvotes = marker.downvotes || 0;
    const userVote = marker.user_vote || 0;

    let voteHtml = "";
    if (!isOwner) {
        if (currentUser) {
            voteHtml = `
        <div class="vote-row">
            <span class="vote-label">Accurate?</span>
            <div class="vote-btns">
                <button class="vote-btn vote-up${userVote === 1 ? " voted" : ""}" data-marker-id="${marker.id}" data-vote="1">&#9650; <span class="upvote-count">${upvotes}</span></button>
                <button class="vote-btn vote-down${userVote === -1 ? " voted" : ""}" data-marker-id="${marker.id}" data-vote="-1">&#9660; <span class="downvote-count">${downvotes}</span></button>
            </div>
        </div>`;
        } else if (upvotes + downvotes > 0) {
            voteHtml = `
        <div class="vote-row vote-row--readonly">
            <span class="vote-label">Accuracy:</span>
            <span class="accuracy-badge">&#9650;${upvotes} &#9660;${downvotes}</span>
        </div>`;
        }
    }

    const updatedAgo = marker.updated_at ? timeAgo(marker.updated_at) : null;
    const updatedBy = marker.updated_by_username ? escapeHtml(marker.updated_by_username) : null;
    const updateHtml = currentUser ? `
        <div class="update-row">
            <input class="update-input" type="text" list="ww-wait-presets" placeholder="New wait time…" data-marker-id="${marker.id}" autocomplete="off" />
            <button class="update-btn" data-marker-id="${marker.id}">Update</button>
        </div>` : "";

    return `
    <div class="ww-popup">
        <div class="ww-popup-head">
            <h3>${escapeHtml(marker.name)}</h3>
            <span class="ww-pill cat-${category}">${escapeHtml(marker.wait_time)}</span>
        </div>
        ${stale ? `<p class="ww-stale-warn">&#9888; This info is over 2 hours old and may be outdated.</p>` : ""}
        <p class="ww-popup-meta">Submitted ${escapeHtml(age)} by <strong>${by}</strong>${badge ? " " + badge : ""}</p>
        ${updatedAgo ? `<p class="ww-popup-meta updated-meta">&#8635; Updated ${updatedAgo} by <strong>${updatedBy}</strong></p>` : ""}
        <p class="ww-popup-meta muted">${formatDateTime(marker.submitted_at)}</p>
        ${marker.notes ? `<p class="ww-popup-notes">${escapeHtml(marker.notes)}</p>` : ""}
        <p class="ww-popup-coords">${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}</p>
        <p class="popup-expiry${expiryCls}">&#8987; ${expiryText}</p>
        ${updateHtml}
        ${voteHtml}
        ${isOwner ? `<button class="btn-danger delete-marker-btn" data-marker-id="${marker.id}">Delete marker</button>` : ""}
    </div>`;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function updateMarkerCount() {
    const el = document.getElementById("marker-count");
    if (el) el.textContent = markerRegistry.size;
}

function rebuildSidebar() {
    const list = document.getElementById("marker-list");
    if (!list) return;

    list.innerHTML = "";

    const entries = [...markerRegistry.values()].sort((a, b) => {
        const da = parseDate(a.data.submitted_at);
        const db = parseDate(b.data.submitted_at);
        return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });

    if (entries.length === 0) {
        list.innerHTML = `<div class="marker-list-empty">No markers yet. Right-click the map or tap <strong>+ Pin</strong> to add one.</div>`;
        updateMarkerCount();
        return;
    }

    for (const { data } of entries) {
        const category = categorizeWait(data.wait_time);
        const effectiveTs = data.updated_at || data.submitted_at;
        const stale = isStale(effectiveTs);
        const age = timeAgo(effectiveTs);
        const byRaw = data.created_by_username;
        const by = byRaw
            ? `<a class="username-link" href="/profile/${encodeURIComponent(byRaw)}" target="_blank">${escapeHtml(byRaw)}</a>`
            : "Anonymous";
        const expiryMs = msUntilExpiry(data);
        const expirySoon = expiryMs < 30 * 60 * 1000;
        const badge = tierBadge(data.creator_tier);
        const isOwner = currentUser && currentUser.username === data.created_by_username;

        const item = document.createElement("div");
        item.className = `mli${stale ? " mli--stale" : ""}`;
        item.id = `mli-${data.id}`;
        const upvotes = data.upvotes || 0;
        const downvotes = data.downvotes || 0;
        const accuracyBadge = (upvotes + downvotes > 0)
            ? `<span class="accuracy-badge" title="Accuracy votes">&#9650;${upvotes} &#9660;${downvotes}</span>`
            : "";

        item.innerHTML = `
            <div class="mli-dot cat-${category}"></div>
            <div class="mli-body">
                <div class="mli-name">${escapeHtml(data.name)}</div>
                <div class="mli-meta">by ${by}${badge ? " " + badge : ""} &middot; ${escapeHtml(age)}</div>
                <div class="mli-expiry${expirySoon ? " expiry-soon" : ""}" data-marker-id="${data.id}">${formatExpiry(expiryMs)}</div>
            </div>
            <span class="mli-pill cat-${category}">${escapeHtml(data.wait_time)}</span>
            ${accuracyBadge}
            ${isOwner ? `<button class="btn-icon-sm delete-marker-btn" data-marker-id="${data.id}" title="Delete this marker">&times;</button>` : ""}
        `;

        item.addEventListener("click", (e) => {
            if (e.target.closest(".delete-marker-btn")) return;
            const entry = markerRegistry.get(data.id);
            if (entry) {
                map.flyTo([data.lat, data.lng], 16, { duration: 0.5 });
                setTimeout(() => entry.leafletMarker.openPopup(), 550);
            }
        });

        list.appendChild(item);
    }

    updateMarkerCount();
}

// ─── Map marker management ───────────────────────────────────────────────────
function addMarkerToMap(marker) {
    if (markerRegistry.has(marker.id)) return;

    const category = categorizeWait(marker.wait_time);
    const effectiveTs = marker.updated_at || marker.submitted_at;
    const stale = isStale(effectiveTs);
    const age = timeAgo(effectiveTs);
    const icon = createMarkerIcon(category, stale);

    const leafletMarker = L.marker([marker.lat, marker.lng])
        .setIcon(icon)
        .addTo(map)
        .bindPopup(() => buildPopupContent(marker), { maxWidth: 290 });

    const ageDisplay = stale ? `${age} (old)` : age;
    const tooltipHtml = `
        <div class="ww-tooltip">
            <div class="ww-tooltip-wait cat-${category}">${escapeHtml(marker.wait_time)}</div>
            <div class="ww-tooltip-age${stale ? " ww-stale-text" : ""}">${escapeHtml(ageDisplay || "Unknown")}</div>
        </div>`;

    leafletMarker.bindTooltip(tooltipHtml, {
        permanent: true,
        direction: "top",
        offset: [0, -40],
        className: `ww-tooltip-leaflet cat-${category}`,
        opacity: 0.97,
        sticky: false,
        interactive: false,
    });

    markerRegistry.set(marker.id, { leafletMarker, data: marker });
}

function removeMarkerFromMap(id) {
    const entry = markerRegistry.get(id);
    if (!entry) return;
    map.removeLayer(entry.leafletMarker);
    markerRegistry.delete(id);
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function loadMarkers() {
    try {
        const res = await fetch("/api/markers", { credentials: "same-origin" });
        if (!res.ok) throw new Error("Failed");
        const markers = await res.json();
        markers.forEach(addMarkerToMap);
        rebuildSidebar();
        const n = markers.length;
        setStatus(n ? `${n} marker${n !== 1 ? "s" : ""} loaded.` : "No markers yet. Right-click or use + Pin to add one.");
    } catch {
        setStatus("Could not load markers.");
    }
}

async function refreshMarkers() {
    try {
        const res = await fetch("/api/markers", { credentials: "same-origin" });
        if (!res.ok) return;
        const fresh = await res.json();
        const freshIds = new Set(fresh.map((m) => m.id));

        let changed = false;
        for (const id of markerRegistry.keys()) {
            if (!freshIds.has(id)) { removeMarkerFromMap(id); changed = true; }
        }
        for (const m of fresh) {
            if (!markerRegistry.has(m.id)) {
                addMarkerToMap(m);
                changed = true;
            } else {
                const entry = markerRegistry.get(m.id);
                // Sync wait_time/updated_at if changed
                if (entry.data.wait_time !== m.wait_time || entry.data.updated_at !== m.updated_at) {
                    Object.assign(entry.data, m);
                    const cat = categorizeWait(m.wait_time);
                    const stale = isStale(m.updated_at || m.submitted_at);
                    entry.leafletMarker.setIcon(createMarkerIcon(cat, stale));
                    entry.leafletMarker.setPopupContent(() => buildPopupContent(entry.data));
                    changed = true;
                }
            }
        }
        if (changed) rebuildSidebar();
    } catch {
        // Silent fail on background refresh
    }
}

async function saveMarker(data) {
    const res = await fetch("/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "same-origin",
    });
    if (!res.ok) {
        if (res.status === 401) openAuthModal("login");
        throw new Error("Failed to save marker");
    }
    return res.json();
}

async function deleteMarker(id) {
    if (!confirm("Delete this marker?")) return;
    const res = await fetch(`/api/markers/${id}`, { method: "DELETE", credentials: "same-origin" });
    if (!res.ok) { alert("Could not delete marker."); return; }
    map.closePopup();
    removeMarkerFromMap(id);
    rebuildSidebar();
    setStatus("Marker deleted.");
}

async function updateMarker(markerId, waitTime) {
    const res = await fetch(`/api/markers/${markerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wait_time: waitTime }),
        credentials: "same-origin",
    });
    if (!res.ok) return;
    const updated = await res.json();

    const entry = markerRegistry.get(markerId);
    if (entry) {
        Object.assign(entry.data, updated);
        const newCategory = categorizeWait(updated.wait_time);
        const newStale = isStale(updated.updated_at || updated.submitted_at);
        entry.leafletMarker.setIcon(createMarkerIcon(newCategory, newStale));
        entry.leafletMarker.setPopupContent(() => buildPopupContent(entry.data));
        // Refresh tooltip
        entry.leafletMarker.unbindTooltip();
        const age = timeAgo(updated.updated_at || updated.submitted_at);
        const tooltipHtml = `
            <div class="ww-tooltip">
                <div class="ww-tooltip-wait cat-${newCategory}">${escapeHtml(updated.wait_time)}</div>
                <div class="ww-tooltip-age${newStale ? " ww-stale-text" : ""}">${escapeHtml(age || "Unknown")}</div>
            </div>`;
        entry.leafletMarker.bindTooltip(tooltipHtml, {
            permanent: true, direction: "top", offset: [0, -40],
            className: `ww-tooltip-leaflet cat-${newCategory}`, opacity: 0.97,
            sticky: false, interactive: false,
        });
    }
    rebuildSidebar();
    setStatus(`Wait time updated: ${updated.wait_time}`);
}

async function voteMarker(markerId, voteValue) {
    const res = await fetch(`/api/markers/${markerId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote: voteValue }),
        credentials: "same-origin",
    });
    if (!res.ok) return;
    const result = await res.json();

    const entry = markerRegistry.get(markerId);
    if (entry) {
        entry.data.upvotes = result.upvotes;
        entry.data.downvotes = result.downvotes;
        entry.data.user_vote = result.user_vote;
        entry.leafletMarker.setPopupContent(() => buildPopupContent(entry.data));
    }

    if (currentUser) {
        // Re-fetch accurate karma from server
        const meRes = await fetch("/api/auth/me", { credentials: "same-origin" });
        if (meRes.ok) {
            const me = await meRes.json();
            if (me.logged_in && currentUser) {
                currentUser.karma = me.karma || 0;
                setAuthUI();
            }
        }
    }

    rebuildSidebar();
}

// ─── Tiers modal ─────────────────────────────────────────────────────────────
function openTiersModal() {
    const modal = document.getElementById("tiers-modal");
    if (!modal) return;

    // Build tier rows
    const body = document.getElementById("tiers-body");
    if (body) {
        body.innerHTML = "";
        const currentTierName = currentUser?.tier || null;
        TIER_DEFS.forEach(({ min, name }) => {
            const isActive = currentTierName && currentTierName.toLowerCase() === name.toLowerCase();
            const row = document.createElement("div");
            row.className = `tier-row${isActive ? " tier-row--active" : ""}`;
            const threshold = min === 0 ? "Starting tier" : `${min}+ submissions`;
            row.innerHTML = `
                <span class="tier-badge tier--${name.toLowerCase()}">${escapeHtml(name)}</span>
                <span class="tier-row-label">${escapeHtml(threshold)}</span>
                ${isActive ? `<span class="tier-row-current" title="Your current tier">&#9733; Current</span>` : ""}
            `;
            body.appendChild(row);
        });
    }

    // Build progress section
    const progressEl = document.getElementById("tiers-progress");
    if (progressEl) {
        if (currentUser) {
            const total = currentUser.total_markers || 0;
            const currentIndex = TIER_DEFS.reduce((idx, t, i) => (total >= t.min ? i : idx), 0);
            const nextTier = TIER_DEFS[currentIndex + 1];
            if (nextTier) {
                const prevMin = TIER_DEFS[currentIndex].min;
                const range = nextTier.min - prevMin;
                const progress = total - prevMin;
                const pct = Math.min(100, Math.round((progress / range) * 100));
                const needed = nextTier.min - total;
                progressEl.innerHTML = `
                    <p class="tiers-progress-text">You've submitted <strong>${total}</strong> marker${total !== 1 ? "s" : ""}. <strong>${needed}</strong> more until <span class="tier-badge tier--${nextTier.name.toLowerCase()}">${escapeHtml(nextTier.name)}</span>.</p>
                    <div class="tier-progress-bar"><div class="tier-progress-fill tier--${TIER_DEFS[currentIndex].name.toLowerCase()}-fill" style="width:${pct}%"></div></div>
                `;
            } else {
                progressEl.innerHTML = `<p class="tiers-progress-text">&#127942; You've reached the highest tier with <strong>${total}</strong> submissions!</p>`;
            }
            progressEl.hidden = false;
        } else {
            progressEl.hidden = true;
        }
    }

    modal.hidden = false;
    modal.style.display = "flex";
}

function closeTiersModal() {
    const modal = document.getElementById("tiers-modal");
    if (modal) { modal.hidden = true; modal.style.display = "none"; }
}

// ─── Marker form popup ───────────────────────────────────────────────────────
function openMarkerForm(latlng) {
    if (activeFormPopup) {
        map.closePopup(activeFormPopup);
        activeFormPopup = null;
    }
    exitPlaceMode();

    const notSignedIn = !currentUser;
    const html = `
    <form id="ww-form" class="ww-form">
        <div class="ww-form-head">
            <h3>Add wait time</h3>
            <p>${notSignedIn ? '<span class="form-auth-note">Sign in first to save markers.</span>' : "Sharing in Pacific Time"}</p>
        </div>
        <label for="f-name">Location name</label>
        <input id="f-name" type="text" placeholder="Restaurant, store, café&hellip;" required autocomplete="off" />
        <label for="f-wait">Current wait time</label>
        <input id="f-wait" type="text" list="ww-wait-presets" placeholder="e.g. 15 min" required autocomplete="off" />
        <label for="f-notes">Notes <span class="optional">(optional)</span></label>
        <textarea id="f-notes" rows="2" placeholder="Any helpful details&hellip;"></textarea>
        <div class="ww-form-actions">
            <button type="button" class="btn-secondary" id="f-cancel">Cancel</button>
            <button type="submit" class="btn-primary" id="f-submit">${notSignedIn ? "Sign in to add" : "Add marker"}</button>
        </div>
    </form>`;

    const popup = L.popup({ closeButton: false, className: "form-popup", maxWidth: 310, autoPan: true })
        .setLatLng(latlng)
        .setContent(html);

    activeFormPopup = popup; // store ref before openOn so cancel/close handlers can use it

    map.once("popupopen", () => {
        const form = document.getElementById("ww-form");
        if (!form) return;
        form.querySelector("#f-name").focus();

        form.querySelector("#f-cancel").addEventListener("click", () => {
            map.closePopup(activeFormPopup);
            activeFormPopup = null;
        });

        form.addEventListener("submit", async (e) => {
            e.preventDefault();

            if (!currentUser) {
                map.closePopup(activeFormPopup);
                activeFormPopup = null;
                openAuthModal("login");
                setStatus("Sign in to save markers.");
                return;
            }

            const name = form.querySelector("#f-name").value.trim();
            const wait_time = form.querySelector("#f-wait").value.trim();
            const notes = form.querySelector("#f-notes").value.trim();
            if (!name || !wait_time) return;

            const submitBtn = form.querySelector("#f-submit");
            submitBtn.disabled = true;
            submitBtn.textContent = "Saving\u2026";

            try {
                const saved = await saveMarker({ name, wait_time, notes, lat: latlng.lat, lng: latlng.lng });
                addMarkerToMap(saved);
                // Update local tier state so the header badge reflects the new count immediately
                if (currentUser && saved.creator_tier) {
                    currentUser.tier = saved.creator_tier;
                    currentUser.total_markers = (currentUser.total_markers || 0) + 1;
                    setAuthUI();
                }
                rebuildSidebar();
                map.closePopup(activeFormPopup);
                activeFormPopup = null;
                setStatus(`Marker added: ${saved.name}`);
            } catch {
                submitBtn.disabled = false;
                submitBtn.textContent = "Add marker";
                setStatus("Could not save marker. Please try again.");
            }
        });
    });

    popup.openOn(map); // open AFTER registering the popupopen listener
}

// ─── Place mode ──────────────────────────────────────────────────────────────
function addPlaceModeControl() {
    const Control = L.Control.extend({
        options: { position: "bottomright" },
        onAdd() {
            const wrap = L.DomUtil.create("div", "ww-place-wrap");
            const btn = L.DomUtil.create("button", "ww-place-btn", wrap);
            btn.type = "button";
            btn.textContent = "+ Pin";
            btn.title = "Enter place mode — then click the map to drop a marker";
            L.DomEvent.on(btn, "click", L.DomEvent.stop);
            L.DomEvent.on(btn, "click", togglePlaceMode);
            return wrap;
        },
    });
    new Control().addTo(map);
}

function togglePlaceMode() {
    placeMode = !placeMode;
    const btn = document.querySelector(".ww-place-btn");
    if (btn) {
        btn.classList.toggle("active", placeMode);
        btn.textContent = placeMode ? "Cancel" : "+ Pin";
    }
    map.getContainer().style.cursor = placeMode ? "crosshair" : "";
    if (placeMode) setStatus("Click anywhere on the map to place a marker.");
}

function exitPlaceMode() {
    if (!placeMode) return;
    placeMode = false;
    const btn = document.querySelector(".ww-place-btn");
    if (btn) { btn.classList.remove("active"); btn.textContent = "+ Pin"; }
    map.getContainer().style.cursor = "";
}

// ─── Map click handlers ──────────────────────────────────────────────────────
map.on("click", (e) => { if (placeMode) openMarkerForm(e.latlng); });
map.on("contextmenu", (e) => openMarkerForm(e.latlng));

// ─── Delete button delegation ────────────────────────────────────────────────
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".delete-marker-btn");
    if (!btn) return;
    e.stopPropagation();
    const id = parseInt(btn.dataset.markerId, 10);
    if (!isNaN(id)) deleteMarker(id);
});

// ─── Update button delegation ────────────────────────────────────────────────
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".update-btn");
    if (!btn) return;
    e.stopPropagation();
    const id = parseInt(btn.dataset.markerId, 10);
    const input = btn.closest(".update-row")?.querySelector(".update-input");
    const waitTime = input?.value.trim();
    if (!isNaN(id) && waitTime) updateMarker(id, waitTime);
});

// ─── Vote button delegation ───────────────────────────────────────────────────
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".vote-btn");
    if (!btn) return;
    e.stopPropagation();
    const id   = parseInt(btn.dataset.markerId, 10);
    const vote = parseInt(btn.dataset.vote, 10);
    if (!isNaN(id) && !isNaN(vote)) voteMarker(id, vote);
});

// ─── Geolocation ─────────────────────────────────────────────────────────────
function getUserLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lng } = pos.coords;
            map.setView([lat, lng], 15);
            if (userMarker) map.removeLayer(userMarker);
            userMarker = L.marker([lat, lng]).addTo(map).bindPopup("You are here.").openPopup();
            setStatus("Location found. Right-click or tap + Pin to add a wait-time marker.");
        },
        () => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// ─── Auth ────────────────────────────────────────────────────────────────────
function setAuthUI() {
    const statusEl = document.getElementById("account-status");
    const openBtn = document.getElementById("auth-open-btn");
    const logoutBtn = document.getElementById("auth-logout-btn");
    if (!statusEl || !openBtn || !logoutBtn) return;

    if (currentUser?.username) {
        const badge = currentUser.tier ? tierBadge(currentUser.tier) : "";
        const karma = currentUser.karma ?? 0;
        statusEl.innerHTML = `Signed in as <strong>${escapeHtml(currentUser.username)}</strong>${badge ? " " + badge : ""} <span class="karma-display" title="Wait Karma">&#9889;${karma}</span>`;
        openBtn.style.display = "none";
        logoutBtn.style.display = "inline-flex";
    } else {
        statusEl.textContent = "Not signed in";
        openBtn.style.display = "inline-flex";
        logoutBtn.style.display = "none";
    }
}

function openAuthModal(mode) {
    const modal = document.getElementById("auth-modal");
    const tabLogin = document.getElementById("auth-tab-login");
    const tabRegister = document.getElementById("auth-tab-register");
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const errEl = document.getElementById("auth-error");
    if (!modal) return;
    if (errEl) { errEl.textContent = ""; errEl.classList.remove("success"); }

    const isReg = mode === "register";
    tabLogin.classList.toggle("active", !isReg);
    tabRegister.classList.toggle("active", isReg);
    loginForm.style.display = isReg ? "none" : "flex";
    registerForm.style.display = isReg ? "flex" : "none";
    modal.hidden = false;
    modal.style.display = "flex";
}

function closeAuthModal() {
    const modal = document.getElementById("auth-modal");
    if (modal) { modal.hidden = true; modal.style.display = "none"; }
}

async function loadMe() {
    const seq = ++_loadMeSeq; // claim a sequence number before the await
    try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        const data = await res.json();
        if (seq !== _loadMeSeq) return; // a newer call finished first — don't clobber it
        currentUser = data.logged_in ? {
            username: data.username,
            email: data.email,
            tier: data.tier || null,
            total_markers: data.total_markers || 0,
            karma: data.karma || 0,
        } : null;
    } catch {
        if (seq !== _loadMeSeq) return;
        currentUser = null;
    }
    setAuthUI();
}

async function handleLogin(formEl) {
    const username = formEl.querySelector("#login-username").value.trim();
    const password = formEl.querySelector("#login-password").value.trim();
    const errEl = document.getElementById("auth-error");

    const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        if (errEl) { errEl.classList.remove("success"); errEl.textContent = data.error || "Invalid credentials."; }
        return;
    }

    await loadMe();
    closeAuthModal();
    setStatus(`Welcome back, ${currentUser.username}!`);
    rebuildSidebar(); // Update delete button visibility
}

async function handleRegister(formEl) {
    const username = formEl.querySelector("#register-username").value.trim();
    const email = formEl.querySelector("#register-email").value.trim();
    const password = formEl.querySelector("#register-password").value.trim();
    const errEl = document.getElementById("auth-error");

    const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
        credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        if (errEl) { errEl.classList.remove("success"); errEl.textContent = data.error || "Could not create account."; }
        return;
    }

    await loadMe();
    closeAuthModal();
    setStatus(`Welcome, ${currentUser.username}!`);
    rebuildSidebar();
}

// ─── Auth event wiring ───────────────────────────────────────────────────────
document.getElementById("auth-open-btn")?.addEventListener("click", () => openAuthModal("login"));

document.getElementById("auth-logout-btn")?.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    await loadMe();
    rebuildSidebar();
    setStatus("You have been signed out.");
});

document.getElementById("auth-close-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAuthModal();
});

document.getElementById("auth-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("auth-modal")) closeAuthModal();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAuthModal(); closeTiersModal(); }
});

document.getElementById("login-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleLogin(document.getElementById("login-form"));
});

document.getElementById("register-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleRegister(document.getElementById("register-form"));
});

document.getElementById("auth-tab-login")?.addEventListener("click", () => openAuthModal("login"));
document.getElementById("auth-tab-register")?.addEventListener("click", () => openAuthModal("register"));

document.getElementById("tiers-btn")?.addEventListener("click", openTiersModal);
document.getElementById("tiers-close-btn")?.addEventListener("click", closeTiersModal);
document.getElementById("tiers-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("tiers-modal")) closeTiersModal();
});

document.getElementById("refresh-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    if (btn) btn.disabled = true;
    await refreshMarkers();
    if (btn) btn.disabled = false;
    setStatus("Markers refreshed.");
});

// ─── Location search ─────────────────────────────────────────────────────────
async function searchLocation(query) {
    const q = query.trim();
    if (!q) return;
    const btn = document.getElementById("location-search-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Searching\u2026"; }
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
            { headers: { "Accept-Language": "en" } }
        );
        const data = await res.json();
        if (data.length === 0) {
            setStatus(`No results found for "${q}".`);
            return;
        }
        const { lat, lon, display_name } = data[0];
        map.flyTo([parseFloat(lat), parseFloat(lon)], 14, { duration: 0.8 });
        setStatus(`Showing: ${display_name}`);
    } catch {
        setStatus("Location search failed. Please try again.");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "\uD83D\uDD0D Search"; }
    }
}

document.getElementById("location-search-btn")?.addEventListener("click", () => {
    searchLocation(document.getElementById("location-search-input")?.value || "");
});

document.getElementById("location-search-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchLocation(e.target.value);
});

// ─── Live countdown refresh ──────────────────────────────────────────────────
function refreshCountdowns() {
    for (const { data } of markerRegistry.values()) {
        const el = document.querySelector(`.mli-expiry[data-marker-id="${data.id}"]`);
        if (!el) continue;
        const ms = msUntilExpiry(data);
        el.textContent = formatExpiry(ms);
        el.classList.toggle("expiry-soon", ms < 30 * 60 * 1000);
    }
}

// ─── Init ────────────────────────────────────────────────────────────────────
addPlaceModeControl();
getUserLocation();
loadMarkers();
loadMe();
setInterval(refreshMarkers, REFRESH_MS);
setInterval(refreshCountdowns, 30 * 1000);
