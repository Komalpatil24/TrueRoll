/**
 * TrueRoll – backend server
 *
 *  - serves the frontend (login page + dashboard)
 *  - wallet login: the user signs a one-time nonce with MetaMask, the server verifies the
 *    signature and hands back a signed session token (no passwords anywhere)
 *  - role-aware REST API that reads the smart contract: stats, students, reports,
 *    CSV exports, low-attendance report, activity feed, login audit log
 *
 * Only needs the `ethers` package that Hardhat already installs.
 *
 *   npm run start            -> http://localhost:3000
 *   env: PORT, RPC_URL (default http://127.0.0.1:8545), JWT_SECRET, TOKEN_TTL_HOURS
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ethers = require("ethers");

const token = require("./lib/token");
const { toCsv } = require("./lib/csv");
const { createLimiter } = require("./lib/ratelimit");

const FRONTEND = path.join(__dirname, "..", "frontend");
const PORT = Number(process.env.PORT) || 3000;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const TOKEN_TTL = (Number(process.env.TOKEN_TTL_HOURS) || 8) * 3600;
const NONCE_TTL_MS = 5 * 60 * 1000;
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ───────────────────────── small helpers ─────────────────────────
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
    "Cache-Control": "no-store",
  });
  res.end(csv);
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || "unknown";
const toAddress = (a) => {
  try {
    return ethers.getAddress(String(a));
  } catch {
    return null;
  }
};
const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
const pct = (att, total) => (total > 0 ? Math.round((att * 100) / total) : 0);

// ───────────────────────── blockchain access ─────────────────────────
let cached = { mtime: 0, contract: null, address: null };

/** Reads frontend/contract.json (re-read whenever `npm run deploy` rewrites it). */
function getContract() {
  const file = path.join(FRONTEND, "contract.json");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(503, "contract.json not found. Run `npm run deploy` first.");
  }
  if (stat.mtimeMs !== cached.mtime) {
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    cached = {
      mtime: stat.mtimeMs,
      address: meta.address,
      contract: new ethers.Contract(meta.address, meta.abi, provider),
    };
  }
  return cached.contract;
}

function sessionStatus(s, nowSec = Math.floor(Date.now() / 1000)) {
  if (s.closed) return "closed";
  if (nowSec < s.startTime) return "upcoming";
  return nowSec <= s.endTime ? "open" : "ended";
}

function sessionJson(s) {
  const out = {
    id: Number(s.id),
    title: s.title,
    teacher: s.teacher,
    startTime: Number(s.startTime),
    endTime: Number(s.endTime),
    closed: s.closed,
    presentCount: Number(s.presentCount),
  };
  out.status = sessionStatus(out);
  return out;
}

async function rolesOf(c, address) {
  const [owner, teacher, student] = await Promise.all([c.owner(), c.isTeacher(address), c.getStudent(address)]);
  return {
    admin: owner.toLowerCase() === address.toLowerCase(),
    teacher,
    student: student.registered,
    name: student.registered ? student.name : null,
    rollNo: student.registered ? student.rollNo : null,
  };
}
const isStaff = (r) => r.admin || r.teacher;

async function allSessions(c) {
  return (await c.getAllSessions()).map(sessionJson);
}

/** Every registered student with their attendance numbers. */
async function studentsWithStats(c) {
  const addrs = await c.getStudents();
  const total = Number(await c.sessionCount());
  const rows = await Promise.all(
    addrs.map(async (a) => {
      const [st, stats] = await Promise.all([c.getStudent(a), c.getAttendanceStats(a)]);
      const attended = Number(stats.attended);
      return {
        address: a,
        name: st.name,
        rollNo: st.rollNo,
        registeredAt: Number(st.registeredAt),
        attended,
        total,
        percent: pct(attended, total),
      };
    })
  );
  return rows.sort((x, y) => x.rollNo.localeCompare(y.rollNo, undefined, { numeric: true }));
}

async function studentReport(c, address) {
  const st = await c.getStudent(address);
  if (!st.registered) throw new HttpError(404, "That wallet is not a registered student");
  const [present, sessions] = await Promise.all([c.getStudentReport(address), allSessions(c)]);
  const entries = sessions.map((s, i) => ({
    sessionId: s.id,
    title: s.title,
    startTime: s.startTime,
    sessionStatus: s.status,
    present: Boolean(present[i]),
  }));
  const attended = entries.filter((e) => e.present).length;
  return {
    address,
    name: st.name,
    rollNo: st.rollNo,
    attended,
    total: entries.length,
    percent: pct(attended, entries.length),
    sessions: entries,
  };
}

function assertSessionAccess(roles, user, session) {
  if (!isStaff(roles)) throw new HttpError(403, "Teachers and admins only");
  if (!roles.admin && session.teacher.toLowerCase() !== user.toLowerCase())
    throw new HttpError(403, "You can only view your own sessions");
}

async function getSessionOr404(c, id) {
  if (!/^\d+$/.test(id)) throw new HttpError(400, "Bad session id");
  if (BigInt(id) >= (await c.sessionCount())) throw new HttpError(404, "No such session");
  return sessionJson(await c.getSession(id));
}

/** Roll sheet for one session: every registered student, Present / Absent. */
async function sessionSheet(c, session) {
  const [students, marked, overridden] = await Promise.all([
    studentsWithStats(c),
    c.queryFilter(c.filters.AttendanceMarked(session.id)),
    c.queryFilter(c.filters.AttendanceOverridden(session.id)),
  ]);
  const when = new Map(marked.map((e) => [e.args.student.toLowerCase(), Number(e.args.timestamp)]));
  const manual = new Set(overridden.map((e) => e.args.student.toLowerCase()));
  return students.map((s) => {
    const key = s.address.toLowerCase();
    return {
      rollNo: s.rollNo,
      name: s.name,
      address: s.address,
      present: when.has(key),
      markedAt: when.has(key) ? when.get(key) : null,
      method: when.has(key) ? (manual.has(key) ? "teacher" : "self") : null,
    };
  });
}

const EVENT_NAMES = [
  "SessionCreated", "SessionClosed", "SessionExtended", "AttendanceMarked", "AttendanceOverridden",
  "StudentRegistered", "TeacherAdded", "TeacherRemoved", "OwnershipTransferred",
];

async function activityFeed(c, roles, user, limit) {
  const logs = (await Promise.all(EVENT_NAMES.map((n) => c.queryFilter(n)))).flat();
  const me = user.toLowerCase();
  const visible = logs.filter((l) => {
    if (isStaff(roles)) return true;
    const n = l.fragment.name;
    if (n === "AttendanceMarked" || n === "StudentRegistered") return l.args.student?.toLowerCase() === me;
    if (n === "AttendanceOverridden") return l.args.student.toLowerCase() === me;
    return true;
  });
  visible.sort((a, b) => b.blockNumber - a.blockNumber || (b.index ?? 0) - (a.index ?? 0));
  const top = visible.slice(0, limit);

  const blockTimes = new Map();
  await Promise.all(
    [...new Set(top.map((l) => l.blockNumber))].map(async (n) => blockTimes.set(n, (await provider.getBlock(n)).timestamp))
  );
  const nameCache = new Map();
  const nameOf = async (a) => {
    const k = a.toLowerCase();
    if (!nameCache.has(k)) {
      const st = await c.getStudent(a);
      nameCache.set(k, st.registered ? `${st.name} (${st.rollNo})` : `${a.slice(0, 6)}…${a.slice(-4)}`);
    }
    return nameCache.get(k);
  };
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return Promise.all(
    top.map(async (l) => {
      const a = l.args;
      const n = l.fragment.name;
      let text;
      switch (n) {
        case "SessionCreated": text = `Session #${a.sessionId} "${a.title}" created by ${short(a.teacher)}`; break;
        case "SessionClosed": text = `Session #${a.sessionId} closed`; break;
        case "SessionExtended": text = `Session #${a.sessionId} extended until ${new Date(Number(a.newEndTime) * 1000).toLocaleTimeString()}`; break;
        case "AttendanceMarked": text = `${await nameOf(a.student)} marked present in session #${a.sessionId}`; break;
        case "AttendanceOverridden": text = `${await nameOf(a.student)} marked present by ${short(a.by)} (manual)`; break;
        case "StudentRegistered": text = `${a.name} (${a.rollNo}) registered`; break;
        case "TeacherAdded": text = `${short(a.teacher)} is now a teacher`; break;
        case "TeacherRemoved": text = `${short(a.teacher)} is no longer a teacher`; break;
        default: text = `Admin role moved to ${short(a.newOwner)}`;
      }
      return { type: n, text, blockNumber: l.blockNumber, time: blockTimes.get(l.blockNumber), txHash: l.transactionHash };
    })
  );
}

// ───────────────────────── auth state ─────────────────────────
const nonces = new Map(); // lowercase address -> { message, exp }
const revoked = new Map(); // jti -> exp (seconds)
const audit = []; // newest last, capped

function logAudit(entry) {
  audit.push({ time: new Date().toISOString(), ...entry });
  if (audit.length > 200) audit.shift();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.exp <= now) nonces.delete(k);
  const sec = Math.floor(now / 1000);
  for (const [k, exp] of revoked) if (exp <= sec) revoked.delete(k);
}, 60 * 1000).unref();

function authenticate(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(h);
  const payload = m && token.verify(m[1], SECRET);
  if (!payload || revoked.has(payload.jti)) throw new HttpError(401, "Please sign in again");
  return payload;
}

// ───────────────────────── routes ─────────────────────────
// auth: "none" | "user" (any signed-in wallet) | "staff" | "admin"
const routes = [];
const route = (method, pattern, auth, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), auth, handler });

route("GET", "/api/health", "none", async () => {
  const [block, network] = await Promise.all([provider.getBlockNumber(), provider.getNetwork()]);
  let contract = null, deployed = false;
  try {
    getContract();
    contract = cached.address;
    deployed = (await provider.getCode(contract)) !== "0x";
  } catch {}
  return { ok: true, rpcUrl: RPC_URL, chainId: Number(network.chainId), block, contract, deployed };
});

route("GET", "/api/auth/nonce", "none", async ({ query }) => {
  const address = toAddress(query.get("address"));
  if (!address) throw new HttpError(400, "A valid wallet address is required");
  const message = [
    "TrueRoll sign-in",
    `Address: ${address}`,
    `Nonce: ${crypto.randomBytes(16).toString("hex")}`,
    `Issued: ${new Date().toISOString()}`,
    "Signing this message is free and does not send a transaction.",
  ].join("\n");
  nonces.set(address.toLowerCase(), { message, exp: Date.now() + NONCE_TTL_MS });
  return { message };
});

route("POST", "/api/auth/login", "none", async ({ body, req }) => {
  const address = toAddress(body.address);
  if (!address || typeof body.signature !== "string") throw new HttpError(400, "address and signature are required");
  const key = address.toLowerCase();
  const rec = nonces.get(key);
  nonces.delete(key); // one attempt per nonce
  const fail = (why) => {
    logAudit({ type: "login_failed", address, ip: clientIp(req), reason: why });
    throw new HttpError(401, "Sign-in failed: " + why);
  };
  if (!rec || rec.exp <= Date.now()) fail("the sign-in request expired, try again");
  let signer;
  try {
    signer = ethers.verifyMessage(rec.message, body.signature);
  } catch {
    fail("invalid signature");
  }
  if (signer.toLowerCase() !== key) fail("signature does not match this wallet");

  const c = getContract();
  const roles = await rolesOf(c, address);
  const jti = crypto.randomBytes(8).toString("hex");
  const jwt = token.sign({ sub: address, jti }, SECRET, TOKEN_TTL);
  logAudit({ type: "login", address, ip: clientIp(req), roles: roleList(roles) });
  return { token: jwt, expiresIn: TOKEN_TTL, address, roles };
});

route("POST", "/api/auth/logout", "user", async ({ user, claims }) => {
  revoked.set(claims.jti, claims.exp);
  logAudit({ type: "logout", address: user });
  return { ok: true };
});

route("GET", "/api/me", "user", async ({ user, roles }) => ({ address: user, roles }));

route("GET", "/api/stats", "user", async ({ c }) => {
  const [sessions, students, teachers] = await Promise.all([allSessions(c), c.getStudents(), c.getTeachers()]);
  const open = sessions.filter((s) => s.status === "open").length;
  const possible = sessions.length * students.length;
  const present = sessions.reduce((n, s) => n + s.presentCount, 0);
  return {
    sessions: sessions.length,
    openSessions: open,
    students: students.length,
    teachers: teachers.length,
    averageAttendance: pct(present, possible),
  };
});

route("GET", "/api/sessions", "user", async ({ c, user, roles }) => {
  const sessions = await allSessions(c);
  if (!roles.student) return { sessions: sessions.reverse() };
  const mine = await c.getStudentReport(user);
  return { sessions: sessions.map((s, i) => ({ ...s, attended: Boolean(mine[i]) })).reverse() };
});

route("GET", "/api/sessions/(\\d+)/attendees", "staff", async ({ c, user, roles, params }) => {
  const session = await getSessionOr404(c, params[0]);
  assertSessionAccess(roles, user, session);
  const sheet = await sessionSheet(c, session);
  return { session, attendees: sheet.filter((r) => r.present), absent: sheet.filter((r) => !r.present) };
});

route("GET", "/api/sessions/(\\d+)/export.csv", "staff", async ({ c, user, roles, params, res }) => {
  const session = await getSessionOr404(c, params[0]);
  assertSessionAccess(roles, user, session);
  const sheet = await sessionSheet(c, session);
  const csv = toCsv(
    ["Roll No", "Name", "Wallet", "Status", "Marked At", "Method"],
    sheet.map((r) => [r.rollNo, r.name, r.address, r.present ? "Present" : "Absent", r.markedAt ? iso(r.markedAt) : "", r.method || ""])
  );
  return { csv, filename: `session-${session.id}-${session.title}.csv` };
});

route("GET", "/api/students", "staff", async ({ c }) => ({ students: await studentsWithStats(c) }));

function reportAccess(roles, user, address) {
  if (!address) throw new HttpError(400, "Bad wallet address");
  if (!isStaff(roles) && address.toLowerCase() !== user.toLowerCase())
    throw new HttpError(403, "You can only view your own report");
}

route("GET", "/api/students/(0x[0-9a-fA-F]{40})/report", "user", async ({ c, user, roles, params }) => {
  const address = toAddress(params[0]);
  reportAccess(roles, user, address);
  return studentReport(c, address);
});

route("GET", "/api/students/(0x[0-9a-fA-F]{40})/export.csv", "user", async ({ c, user, roles, params }) => {
  const address = toAddress(params[0]);
  reportAccess(roles, user, address);
  const r = await studentReport(c, address);
  const csv = toCsv(
    ["Session #", "Title", "Date", "Status"],
    [
      ...r.sessions.map((s) => [s.sessionId, s.title, iso(s.startTime), s.present ? "Present" : "Absent"]),
      [],
      ["Summary", `${r.name} (${r.rollNo})`, "", `${r.attended}/${r.total} = ${r.percent}%`],
    ]
  );
  return { csv, filename: `attendance-${r.rollNo}.csv` };
});

route("GET", "/api/reports/low-attendance", "staff", async ({ c, query }) => {
  let threshold = Number(query.get("threshold") ?? 75);
  if (!Number.isFinite(threshold)) threshold = 75;
  threshold = Math.min(100, Math.max(0, threshold));
  const students = await studentsWithStats(c);
  const low = students.filter((s) => s.total > 0 && s.percent < threshold).sort((a, b) => a.percent - b.percent);
  return { threshold, count: low.length, students: low };
});

route("GET", "/api/activity", "user", async ({ c, user, roles, query }) => {
  const limit = Math.min(100, Math.max(1, parseInt(query.get("limit"), 10) || 20));
  return { events: await activityFeed(c, roles, user, limit) };
});

route("GET", "/api/admin/audit", "admin", async () => ({ entries: [...audit].reverse() }));

function roleList(r) {
  return [r.admin && "admin", r.teacher && "teacher", r.student && "student"].filter(Boolean);
}

// ───────────────────────── request handling ─────────────────────────
const apiLimiter = createLimiter({ windowMs: 60 * 1000, max: 240 });
const authLimiter = createLimiter({ windowMs: 60 * 1000, max: 20 });

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  const isAuthRoute = url.pathname.startsWith("/api/auth/");
  for (const lim of isAuthRoute ? [authLimiter, apiLimiter] : [apiLimiter]) {
    const r = lim(ip);
    if (!r.ok) {
      res.setHeader("Retry-After", r.retryAfter);
      throw new HttpError(429, "Too many requests, slow down");
    }
  }

  const matches = routes.filter((r) => r.re.test(url.pathname));
  if (!matches.length) throw new HttpError(404, "Unknown API endpoint");
  const r = matches.find((m) => m.method === req.method);
  if (!r) throw new HttpError(405, "Method not allowed");

  const ctx = { req, res, query: url.searchParams, params: r.re.exec(url.pathname).slice(1) };
  ctx.body = req.method === "POST" ? await readBody(req) : {};

  if (r.auth !== "none") {
    ctx.claims = authenticate(req);
    ctx.user = ctx.claims.sub;
  }
  if (r.auth !== "none") {
    // every authenticated route reads the chain, so roles are resolved fresh on each
    // request (removing a teacher takes effect immediately)
    ctx.c = getContract();
    ctx.roles = await rolesOf(ctx.c, ctx.user);
    if (r.auth === "staff" && !isStaff(ctx.roles)) throw new HttpError(403, "Teachers and admins only");
    if (r.auth === "admin" && !ctx.roles.admin) throw new HttpError(403, "Admin only");
  }

  const out = await r.handler(ctx);
  if (out && out.csv !== undefined) return sendCsv(res, out.filename, out.csv);
  sendJson(res, 200, out);
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, SECURITY_HEADERS);
    return res.end("Method not allowed");
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end("Bad request");
  }
  if (rel === "/") rel = "/login.html";
  const file = path.resolve(FRONTEND, "." + rel);
  const hidden = path.basename(file).startsWith(".");
  if (!file.startsWith(FRONTEND + path.sep) || hidden) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found (did you run `npm run deploy` first?)");
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function friendlyError(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  const code = err && (err.code || err.info?.error?.code);
  const text = String((err && err.message) || "");
  if (
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"].includes(code) ||
    /ECONNREFUSED|could not detect network|failed to detect network/i.test(text)
  )
    return { status: 503, message: `Cannot reach the blockchain node at ${RPC_URL}. Is \`npx hardhat node\` running?` };
  if (code === "BAD_DATA" || code === "CALL_EXCEPTION")
    return { status: 503, message: "The contract is not deployed on this chain. Run `npm run deploy` again." };
  console.error(err);
  return { status: 500, message: "Internal server error" };
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      const { status, message } = friendlyError(err);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`TrueRoll running at http://localhost:${PORT}`);
    console.log(`Blockchain RPC: ${RPC_URL}`);
    if (!process.env.JWT_SECRET)
      console.log("Tip: set JWT_SECRET to keep users signed in across server restarts.");
  });
}

module.exports = { createServer };
