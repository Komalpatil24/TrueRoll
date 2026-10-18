/* global ethers */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "ca_token";
const CHAIN_ID = 31337;

let provider, signer, account, contract, meta, me;
let studentsView = "all"; // "all" | "low"

// ───────────── helpers ─────────────
function toast(msg, type = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = type;
  t.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = "none"), 5000);
}
function reason(e) {
  return e?.reason || e?.info?.error?.message || e?.shortMessage || e?.message || "Something went wrong";
}
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (ts) => new Date(Number(ts) * 1000).toLocaleString();

function logout(redirect = true) {
  const t = sessionStorage.getItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  const done = () => redirect && location.replace("login.html");
  if (!t) return done();
  fetch("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + t } }).finally(done);
}

async function api(path, opts = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return logout();
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    location.replace("login.html");
    throw new Error("Session expired");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res;
}
const apiJson = async (path) => (await api(path)).json();

async function download(path, fallbackName) {
  try {
    const res = await api(path);
    const cd = res.headers.get("Content-Disposition") || "";
    const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(reason(e), "err");
  }
}

async function tx(promise, okMsg) {
  try {
    const t = await promise;
    toast("Transaction sent, waiting for confirmation…");
    await t.wait();
    toast(okMsg, "good");
    await refresh();
  } catch (e) {
    toast(reason(e), "err");
  }
}

function setupError(html) {
  const el = $("setupMsg");
  el.innerHTML = "⚠️ " + html;
  el.classList.remove("hidden");
}

// ───────────── start-up: token → wallet → contract ─────────────
async function ensureChain() {
  const net = await provider.getNetwork();
  if (Number(net.chainId) === CHAIN_ID) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
  } catch (err) {
    if (err.code === 4902 || /Unrecognized chain/i.test(err.message || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x7a69",
          chainName: "Hardhat Local",
          rpcUrls: ["http://127.0.0.1:8545"],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        }],
      });
    } else throw err;
  }
  provider = new ethers.BrowserProvider(window.ethereum);
}

async function start() {
  if (!sessionStorage.getItem(TOKEN_KEY)) return location.replace("login.html");
  try {
    me = await apiJson("/api/me");
  } catch (e) {
    return setupError(esc(e.message));
  }
  account = me.address;
  $("account").textContent = short(account);

  // The wallet is only needed to send transactions. Reading works through the server.
  try {
    const res = await fetch("contract.json", { cache: "no-store" });
    if (!res.ok) throw new Error("contract.json not found. Run `npm run deploy` first.");
    meta = await res.json();
    $("contractAddr").textContent = meta.address;
    if (!window.ethereum) throw new Error("MetaMask not found. Install the MetaMask extension to send transactions.");
    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_accounts", []);
    if (!accounts.length || accounts[0].toLowerCase() !== account.toLowerCase())
      return logout(); // wallet account differs from the signed-in account
    await ensureChain();
    signer = await provider.getSigner();
    contract = new ethers.Contract(meta.address, meta.abi, signer);
  } catch (e) {
    setupError(esc(reason(e)) + " <span class='muted'>You can still browse, but actions that need your wallet are disabled.</span>");
  }
  await refresh();
}

// ───────────── rendering ─────────────
async function refresh() {
  try {
    me = await apiJson("/api/me");
    const [stats, sess] = await Promise.all([apiJson("/api/stats"), apiJson("/api/sessions")]);
    const { admin, teacher, student } = me.roles;
    const staff = admin || teacher;

    $("roleBadges").innerHTML =
      (admin ? '<span class="badge warn">Admin</span> ' : "") +
      (teacher ? '<span class="badge ok">Teacher</span> ' : "") +
      (student ? `<span class="badge ok">${esc(me.roles.name)} · ${esc(me.roles.rollNo)}</span>` : "") +
      (!admin && !teacher && !student ? '<span class="badge">New</span>' : "");

    $("registerCard").classList.toggle("hidden", student || staff); // admins and teachers do not register as students
    $("teacherCard").classList.toggle("hidden", !teacher);
    $("adminCard").classList.toggle("hidden", !admin);
    $("studentsCard").classList.toggle("hidden", !staff);
    $("myReportCard").classList.toggle("hidden", !student);
    $("auditCard").classList.toggle("hidden", !admin);

    $("stSessions").textContent = stats.sessions;
    $("stOpen").textContent = stats.openSessions;
    $("stStudents").textContent = stats.students;
    $("stAvg").textContent = stats.sessions && stats.students ? stats.averageAttendance + "%" : "–";

    renderSessions(sess.sessions);

    const jobs = [loadFeed()];
    if (student) jobs.push(loadMyReport());
    if (staff) jobs.push(loadStudents());
    if (admin) jobs.push(loadAdmin());
    await Promise.all(jobs);
  } catch (e) {
    if (e.message !== "Session expired") toast(reason(e), "err");
  }
}

function renderSessions(sessions) {
  const { admin, student } = me.roles;
  const rows = sessions.map((s) => {
    const mine = s.teacher.toLowerCase() === account.toLowerCase();
    const manage = !s.closed && (admin || (me.roles.teacher && mine));
    const status = { closed: ["bad", "Closed"], open: ["ok", "Open"], upcoming: ["warn", "Upcoming"], ended: ["", "Ended"] }[s.status];
    let actions = "";
    if (student && s.status === "open" && !s.attended) actions += `<button class="small" data-act="mark" data-id="${s.id}">Mark present</button>`;
    if (s.attended) actions += '<span class="badge ok">✔ You attended</span>';
    if (manage) {
      actions += `<button class="secondary small" data-act="extend" data-id="${s.id}">Extend</button>`;
      actions += `<button class="danger small" data-act="close" data-id="${s.id}">Close</button>`;
    }
    if (admin || (me.roles.teacher && mine)) {
      actions += `<button class="secondary small" data-act="view" data-id="${s.id}">Roll sheet</button>`;
      actions += `<button class="secondary small" data-act="csv" data-id="${s.id}">CSV</button>`;
    }
    return `<tr>
      <td>${s.id}</td>
      <td>${esc(s.title)}<div class="muted">by ${esc(short(s.teacher))}</div></td>
      <td class="muted">${fmt(s.startTime)}<br>→ ${fmt(s.endTime)}</td>
      <td>${s.presentCount}</td>
      <td><span class="badge ${status[0]}">${status[1]}</span></td>
      <td><div class="actions">${actions}</div></td></tr>`;
  });
  $("sessionRows").innerHTML = rows.join("");
  $("noSessions").classList.toggle("hidden", rows.length > 0);

  const mineStats = me.roles.student ? sessions.filter((s) => s.attended).length : null;
  $("stMine").textContent = mineStats === null ? "–" : sessions.length ? `${mineStats}/${sessions.length} (${Math.round((mineStats * 100) / sessions.length)}%)` : "0/0";
}

async function loadFeed() {
  const { events } = await apiJson("/api/activity?limit=15");
  $("feed").innerHTML =
    events.map((e) => `<li><span>${esc(e.text)}</span><time>${e.time ? fmt(e.time) : ""}</time></li>`).join("") ||
    '<li class="muted">Nothing has happened yet.</li>';
}

async function loadMyReport() {
  const r = await apiJson(`/api/students/${account}/report`);
  $("myReportRows").innerHTML =
    r.sessions
      .map((s) => `<tr><td>${s.sessionId}</td><td>${esc(s.title)}</td><td class="muted">${fmt(s.startTime)}</td>
        <td>${s.present ? '<span class="badge ok">Present</span>' : '<span class="badge bad">Absent</span>'}</td></tr>`)
      .join("") || '<tr><td colspan="4" class="muted">No sessions yet.</td></tr>';
}

async function loadStudents() {
  let list;
  if (studentsView === "low") {
    const t = Math.min(100, Math.max(0, Number($("threshold").value) || 0));
    list = (await apiJson(`/api/reports/low-attendance?threshold=${t}`)).students;
  } else list = (await apiJson("/api/students")).students;
  $("studentRows").innerHTML = list
    .map((s) => `<tr>
      <td>${esc(s.rollNo)}</td>
      <td>${esc(s.name)}<div class="muted">${esc(short(s.address))}</div></td>
      <td><div class="row"><div class="bar ${s.percent < 75 ? "low" : ""}" style="width:90px"><i style="width:${s.percent}%"></i></div>
          <span>${s.attended}/${s.total} · ${s.percent}%</span></div></td>
      <td><button class="secondary small" data-csv="${esc(s.address)}" data-roll="${esc(s.rollNo)}">Report CSV</button></td></tr>`)
    .join("");
  $("noStudents").classList.toggle("hidden", list.length > 0);
}

async function loadAdmin() {
  const [{ entries }, teachers] = await Promise.all([
    apiJson("/api/admin/audit"),
    contract ? contract.getTeachers() : Promise.resolve([]),
  ]);
  $("teacherList").innerHTML = teachers.map((a) => `<li>${esc(a)}</li>`).join("");
  $("auditRows").innerHTML =
    entries
      .slice(0, 30)
      .map((e) => `<tr><td class="muted">${new Date(e.time).toLocaleString()}</td>
        <td><span class="badge ${e.type === "login_failed" ? "bad" : e.type === "login" ? "ok" : ""}">${esc(e.type.replace("_", " "))}</span></td>
        <td><code>${esc(e.address || "")}</code></td><td class="muted">${esc(e.ip || "")}</td></tr>`)
      .join("") || '<tr><td colspan="4" class="muted">No sign-ins yet.</td></tr>';
}

let openSheet = null;
async function showSheet(id) {
  openSheet = id;
  const { session, attendees, absent } = await apiJson(`/api/sessions/${id}/attendees`);
  const canOverride = Boolean(contract); // the contract allows manual marks even after a session ends
  const row = (r, present) => `<tr>
    <td>${esc(r.rollNo)}</td><td>${esc(r.name)}<div class="muted">${esc(short(r.address))}</div></td>
    <td>${present ? `<span class="badge ok">Present</span> <span class="muted">${r.method === "teacher" ? "marked by teacher" : fmt(r.markedAt)}</span>`
                  : '<span class="badge bad">Absent</span>'}</td>
    <td>${!present && canOverride ? `<button class="secondary small" data-override="${esc(r.address)}">Mark present</button>` : ""}</td></tr>`;
  $("attendeesTitle").textContent = `Roll sheet – #${session.id} ${session.title} (${attendees.length} present, ${absent.length} absent)`;
  $("attendeeRows").innerHTML =
    attendees.map((r) => row(r, true)).join("") + absent.map((r) => row(r, false)).join("") ||
    '<tr><td colspan="4" class="muted">No students registered yet.</td></tr>';
  $("attendeesCard").classList.remove("hidden");
  $("attendeesCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ───────────── events ─────────────
const needWallet = () => {
  if (!contract) {
    toast("Wallet not connected – fix the warning at the top first.", "err");
    return false;
  }
  return true;
};

$("logoutBtn").onclick = () => logout();
$("closeAttendees").onclick = () => { openSheet = null; $("attendeesCard").classList.add("hidden"); };

$("regBtn").onclick = () => {
  const name = $("regName").value.trim(), roll = $("regRoll").value.trim();
  if (!name || !roll) return toast("Enter name and roll number", "err");
  if (needWallet()) tx(contract.registerStudent(name, roll), "Registered!");
};

$("sesBtn").onclick = () => {
  const title = $("sesTitle").value.trim(), dur = parseInt($("sesDur").value, 10);
  if (!title) return toast("Enter a title", "err");
  if (!(dur > 0 && dur <= 1440)) return toast("Duration must be 1–1440 minutes", "err");
  if (needWallet()) tx(contract.createSession(title, dur), "Session created!");
};

function addressInput() {
  const a = $("teacherAddr").value.trim();
  if (!ethers.isAddress(a)) { toast("Invalid address", "err"); return null; }
  return a;
}
$("addTeacherBtn").onclick = () => { const a = addressInput(); if (a && needWallet()) tx(contract.addTeacher(a), "Teacher added"); };
$("rmTeacherBtn").onclick = () => { const a = addressInput(); if (a && needWallet()) tx(contract.removeTeacher(a), "Teacher removed"); };
$("transferBtn").onclick = () => {
  const a = addressInput();
  if (!a || !needWallet()) return;
  if (!confirm(`Give the admin role to ${a}?\nYou will lose admin rights. This cannot be undone by you.`)) return;
  tx(contract.transferOwnership(a), "Admin role transferred");
};

$("sessionRows").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = Number(b.dataset.id);
  switch (b.dataset.act) {
    case "mark": if (needWallet()) tx(contract.markAttendance(id), "Attendance marked!"); break;
    case "close": if (needWallet()) tx(contract.closeSession(id), "Session closed"); break;
    case "extend": {
      if (!needWallet()) break;
      const m = parseInt(prompt("Extend by how many minutes? (1–1440)", "10"), 10);
      if (!(m > 0 && m <= 1440)) { if (!Number.isNaN(m)) toast("Enter 1–1440 minutes", "err"); break; }
      tx(contract.extendSession(id, m), `Session extended by ${m} min`);
      break;
    }
    case "view": showSheet(id).catch((er) => toast(reason(er), "err")); break;
    case "csv": download(`/api/sessions/${id}/export.csv`, `session-${id}.csv`); break;
  }
});

$("attendeeRows").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-override]");
  if (!b || openSheet === null || !needWallet()) return;
  const id = openSheet;
  await tx(contract.markStudentPresent(id, b.dataset.override), "Marked present");
  showSheet(id).catch(() => {});
});

$("studentRows").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-csv]");
  if (b) download(`/api/students/${b.dataset.csv}/export.csv`, `attendance-${b.dataset.roll}.csv`);
});
$("myCsvBtn").onclick = () => download(`/api/students/${account}/export.csv`, "my-attendance.csv");

function setView(v) {
  studentsView = v;
  $("tabAll").classList.toggle("active", v === "all");
  $("tabLow").classList.toggle("active", v === "low");
  loadStudents().catch((er) => toast(reason(er), "err"));
}
$("tabAll").onclick = () => setView("all");
$("tabLow").onclick = () => setView("low");
$("threshold").addEventListener("change", () => studentsView === "low" && setView("low"));

if (window.ethereum?.on) {
  // a different wallet account means a different identity: sign in again
  window.ethereum.on("accountsChanged", () => logout());
  window.ethereum.on("chainChanged", () => location.reload());
}

// keep open/ended badges and the feed fresh
setInterval(() => !document.hidden && refresh(), 20000);

start();
