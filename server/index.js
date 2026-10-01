const express = require("express"),
  path = require("path"),
  fs = require("fs"),
  crypto = require("crypto");
const Datastore = require("@seald-io/nedb"),
  bcrypt = require("bcryptjs"),
  jwt = require("jsonwebtoken");
const { SerialPort, ReadlineParser } = require("serialport");
const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DIR, { recursive: true });
const CLOUD = !!process.env.MONGO_URI,
  COLL = ["users", "products", "bills", "settings", "rates", "audit"];
const db = {};
if (!CLOUD)
  COLL.forEach(
    (n) =>
      (db[n] = new Datastore({
        filename: path.join(DIR, n + ".db"),
        autoload: true,
      })),
  );
/* ===== CLOUD DATABASE: same calls as the local DB, stored in MongoDB (Atlas) instead ===== */
async function useMongo(uri) {
  if (/^mongodb\+srv:/.test(uri) && process.env.DNS_SERVERS !== "system")
    require("dns").setServers(
      (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1,8.8.4.4").split(","),
    ); // fixes "querySrv ECONNREFUSED"
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const d = client.db(process.env.MONGO_DB || "billing");
  COLL.forEach((n) => {
    const c = d.collection(n);
    db[n] = {
      findAsync: (q) => c.find(q).toArray(),
      findOneAsync: (q) => c.findOne(q),
      countAsync: (q) => c.countDocuments(q),
      insertAsync: async (doc) => {
        const x = { ...doc };
        if (x._id == null) x._id = crypto.randomBytes(12).toString("hex");
        await c.insertOne(x);
        return x;
      },
      updateAsync: async (q, u, o = {}) => {
        if (!Object.keys(u).some((k) => k.startsWith("$"))) {
          const r = await c.replaceOne(q, u, { upsert: !!o.upsert });
          return { numAffected: r.matchedCount + r.upsertedCount };
        }
        if (o.returnUpdatedDocs)
          return {
            affectedDocuments: await c.findOneAndUpdate(q, u, {
              upsert: !!o.upsert,
              returnDocument: "after",
            }),
          };
        const r = await c.updateOne(q, u, { upsert: !!o.upsert });
        return { numAffected: r.matchedCount };
      },
    };
  });
  await d.collection("users").createIndex({ username: 1 }, { unique: true });
  await d.collection("bills").createIndex({ date: 1 });
  await d.collection("bills").createIndex({ no: 1 }, { unique: true });
  console.log("Connected to cloud database");
}
const MODE = process.env.APP_MODE || "standalone"; // standalone | server | counter
const COUNTER =
  (process.env.COUNTER_ID || "C1")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4) || "C1";
const CENTRAL = (process.env.SERVER_URL || "").replace(/\/$/, "");
let SECRET;
const today = () => new Date().toISOString().slice(0, 10);
const audit = (user, action, detail) =>
  db.audit.insertAsync({ at: new Date().toISOString(), user, action, detail });

/* ================= WEIGHING SCALE (serial or mock) ================= */
const scale = {
  mode: "mock",
  connected: false,
  grams: 0,
  pcs: null,
  stable: true,
  error: "",
  at: 0,
};
let cfg = {
    mode: "mock",
    path: "",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },
  port = null,
  retry,
  hist = [];
const clients = new Set();

/* ===== MULTI-PC: counter PCs forward everything except scale calls to the MAIN server ===== */
const http = require("http"),
  https = require("https"),
  { URL } = require("url"),
  cache = new Map();
function proxy(req, res) {
  const u = new URL(CENTRAL),
    lib = u.protocol === "https:" ? https : http;
  const p = lib.request(
    {
      hostname: u.hostname,
      port: u.port || undefined,
      path: req.originalUrl,
      method: req.method,
      headers: { ...req.headers, host: u.host, "x-counter": COUNTER },
    },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  p.on("error", () =>
    res
      .status(503)
      .json({ error: "Main server not reachable. Check network / main PC." }),
  );
  req.pipe(p);
}
async function remoteUser(t) {
  // counter asks the main server who this token belongs to
  const c = cache.get(t);
  if (c && c.exp > Date.now()) return c.u;
  const r = await fetch(CENTRAL + "/api/me", {
    headers: { Authorization: "Bearer " + t },
  });
  if (!r.ok) throw new Error("bad token");
  const u = await r.json();
  cache.set(t, { u, exp: Date.now() + 60000 });
  return u;
}
/* ===== automatic backup (main / standalone PC): copies data files daily, keeps 14 days ===== */
function backup() {
  try {
    const root = path.join(DIR, "backups"),
      d = path.join(root, today());
    fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(DIR))
      if (f.endsWith(".db"))
        fs.copyFileSync(path.join(DIR, f), path.join(d, f));
    fs.readdirSync(root)
      .sort()
      .slice(0, -14)
      .forEach((x) =>
        fs.rmSync(path.join(root, x), { recursive: true, force: true }),
      );
  } catch (e) {
    console.error("backup failed", e.message);
  }
}
const push = () => {
  scale.at = Date.now();
  const d = `data: ${JSON.stringify(scale)}\n\n`;
  clients.forEach((c) => c.write(d));
};
const later = () => {
  clearTimeout(retry);
  if (cfg.mode === "serial") retry = setTimeout(applyScale, 5000);
};
function fail(e) {
  scale.connected = false;
  scale.error = /denied|busy|EBUSY|in use/i.test(e.message)
    ? "Port already in use"
    : e.message;
  push();
  later();
}
// GENERIC parser: reads "ST,GS,+024.650kg", "  24.650 kg", "12 pcs". Real protocol must be confirmed with the scale manual.
function onLine(line) {
  const m = line.match(/([+-]?\d+(?:\.\d+)?)\s*(kg|g|pcs|pc)?/i);
  if (!m) return;
  let v = parseFloat(m[1]);
  const u = (m[2] || "kg").toLowerCase();
  if (u.startsWith("pc")) scale.pcs = Math.round(v);
  else {
    if (u === "g") v /= 1000;
    if (v < 0) {
      scale.error = "Negative weight";
      scale.grams = 0;
    } else {
      scale.error = "";
      scale.grams = Math.round(v * 1000);
    }
    const flag = /\bUS\b/i.test(line)
      ? false
      : /\bST\b/i.test(line)
        ? true
        : null;
    hist = [...hist, scale.grams].slice(-3);
    scale.stable =
      flag !== null
        ? flag
        : hist.length === 3 && hist.every((x) => x === hist[0]);
  }
  push();
}
async function applyScale() {
  clearTimeout(retry);
  const old = port;
  port = null;
  if (old) {
    try {
      old.isOpen && old.close();
    } catch (e) {}
  }
  if (cfg.mode === "mock") {
    Object.assign(scale, {
      mode: "mock",
      connected: true,
      error: "",
      grams: 0,
      pcs: null,
      stable: true,
    });
    return push();
  }
  Object.assign(scale, {
    mode: "serial",
    connected: false,
    grams: 0,
    pcs: null,
    error: "",
  });
  try {
    const p = (port = new SerialPort({
      path: cfg.path,
      baudRate: +cfg.baudRate,
      dataBits: +cfg.dataBits,
      stopBits: +cfg.stopBits,
      parity: cfg.parity,
      autoOpen: false,
    }));
    p.pipe(new ReadlineParser({ delimiter: "\n" })).on("data", (l) =>
      onLine(String(l).trim()),
    );
    p.on("error", fail);
    p.on("close", () => {
      if (port !== p) return;
      scale.connected = false;
      scale.error = "Scale disconnected";
      push();
      later();
    });
    p.open((err) => {
      if (err) return fail(err);
      scale.connected = true;
      scale.error = "";
      push();
    });
  } catch (e) {
    fail(e);
  }
}

/* ================= HTTP API ================= */
const app = express();
if (MODE === "counter")
  app.use("/api", (req, res, next) =>
    req.path.startsWith("/scale") ? next() : proxy(req, res),
  );
app.use(express.json({ limit: "1mb" }));
const A = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) =>
    res.status(400).json({ error: e.message }),
  );
const auth = (role) => async (req, res, next) => {
  try {
    const t = (req.headers.authorization || "").slice(7) || req.query.token;
    req.user = MODE === "counter" ? await remoteUser(t) : jwt.verify(t, SECRET);
    if (role && req.user.role !== role)
      return res.status(403).json({ error: "Not permitted" });
    next();
  } catch (e) {
    res.status(401).json({ error: "Please login" });
  }
};
const fails = {};
app.post(
  "/api/login",
  A(async (req, res) => {
    const { username = "", password = "", role } = req.body,
      f = fails[username] || { n: 0, until: 0 };
    if (Date.now() < f.until)
      throw new Error("Too many attempts. Wait 1 minute.");
    const u = await db.users.findOneAsync({
      username: username.trim().toLowerCase(),
      active: true,
    });
    if (!u || !bcrypt.compareSync(password, u.pass) || u.role !== role) {
      f.n++;
      if (f.n >= 5) {
        f.n = 0;
        f.until = Date.now() + 60000;
      }
      fails[username] = f;
      throw new Error("Wrong username, password or login type");
    }
    delete fails[username];
    await audit(u.username, "Login", u.role);
    res.json({
      token: jwt.sign(
        { id: u._id, username: u.username, role: u.role, name: u.name },
        SECRET,
        { expiresIn: "12h" },
      ),
      user: { username: u.username, role: u.role, name: u.name },
    });
  }),
);

app.get("/api/me", auth(), (req, res) => res.json(req.user));
app.get(
  "/api/products",
  auth(),
  A(async (req, res) =>
    res.json(
      (await db.products.findAsync({})).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ),
  ),
);
app.post(
  "/api/products",
  auth("MANAGER"),
  A(async (req, res) => {
    const b = req.body,
      name = String(b.name || "").trim();
    if (!name) throw new Error("Name required");
    if (!["KG", "PCS"].includes(b.unit))
      throw new Error("Unit must be KG or PCS");
    const rate = Math.round(+b.rate);
    if (!(rate >= 0)) throw new Error("Invalid rate");
    const doc = {
      name,
      unit: b.unit,
      rate,
      unitWeight: Math.round(+b.unitWeight || 0),
      stock: Math.round(+b.stock || 0),
      code: String(b.code || ""),
      active: b.active !== false,
    };
    if (b._id) {
      const old = await db.products.findOneAsync({ _id: b._id });
      if (old && old.rate !== rate) {
        await db.rates.insertAsync({
          productId: b._id,
          old: old.rate,
          rate,
          by: req.user.username,
          at: new Date().toISOString(),
        });
        await audit(
          req.user.username,
          "Rate Changed",
          `${name} ${old.rate}→${rate}`,
        );
      }
      await db.products.updateAsync({ _id: b._id }, { $set: doc });
    } else {
      await db.products.insertAsync(doc);
      await audit(req.user.username, "Product Created", name);
    }
    res.json({ ok: true });
  }),
);

app.get(
  "/api/users",
  auth("MANAGER"),
  A(async (req, res) =>
    res.json((await db.users.findAsync({})).map(({ pass, ...u }) => u)),
  ),
);
app.post(
  "/api/users",
  auth("MANAGER"),
  A(async (req, res) => {
    const { username = "", password = "", role, name = "" } = req.body,
      un = username.trim().toLowerCase();
    if (!un || password.length < 6)
      throw new Error("Username required and password min 6 characters");
    if (!["MANAGER", "OPERATOR"].includes(role))
      throw new Error("Invalid role");
    if (await db.users.findOneAsync({ username: un }))
      throw new Error("Username exists");
    await db.users.insertAsync({
      username: un,
      pass: bcrypt.hashSync(password, 10),
      role,
      name: name || un,
      active: true,
    });
    await audit(req.user.username, "User Created", un + " " + role);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/users/:id/toggle",
  auth("MANAGER"),
  A(async (req, res) => {
    const u = await db.users.findOneAsync({ _id: req.params.id });
    if (!u || u.username === req.user.username) throw new Error("Not allowed");
    await db.users.updateAsync({ _id: u._id }, { $set: { active: !u.active } });
    res.json({ ok: true });
  }),
);

// bills: server recalculates everything; the client is never trusted
const fy = () => {
  const d = new Date(),
    y = d.getFullYear(),
    s = d.getMonth() >= 3 ? y : y - 1;
  return s + "-" + String(s + 1).slice(2);
};
app.post(
  "/api/bills",
  auth(),
  A(async (req, res) => {
    const { items, customer = "", mode = "CASH", discount = 0 } = req.body,
      M = req.user.role === "MANAGER";
    if (!Array.isArray(items) || !items.length) throw new Error("No items");
    if (!["CASH", "UPI", "CREDIT"].includes(mode))
      throw new Error("Invalid payment mode");
    if (mode === "CREDIT" && !customer.trim())
      throw new Error("Customer name required for credit");
    const lines = [];
    let sub = 0;
    for (const it of items) {
      const p = await db.products.findOneAsync({ _id: it.productId });
      if (!p || !p.active) throw new Error("Invalid product");
      const qty = Math.round(+it.qty);
      if (!(qty > 0)) throw new Error("Quantity must be positive");
      let rate = p.rate;
      if (it.rate != null && Math.round(+it.rate) !== p.rate) {
        if (!M) throw new Error("Only manager can change rate");
        rate = Math.round(+it.rate);
        await audit(
          req.user.username,
          "Rate Override",
          `${p.name} ${p.rate}→${rate}`,
        );
      }
      const manual = it.src === "MANUAL" && p.unit === "KG";
      if (manual) {
        if (!M) throw new Error("Manual weight needs manager");
        await audit(req.user.username, "Manual Weight", `${p.name} ${qty} g`);
      }
      const amount =
        p.unit === "KG" ? Math.round((qty * rate) / 1000) : qty * rate;
      sub += amount;
      lines.push({
        productId: p._id,
        name: p.name,
        unit: p.unit,
        qty,
        rate,
        amount,
        src: manual ? "MANUAL" : "SCALE",
      });
    }
    const disc = Math.min(Math.max(Math.round(+discount) || 0, 0), sub),
      total = Math.round((sub - disc) / 100) * 100;
    const hc = String(req.headers["x-counter"] || "").toUpperCase(),
      ctr = /^[A-Z0-9]{1,4}$/.test(hc) ? hc : COUNTER;
    const seq = (
      await db.settings.updateAsync(
        { _id: "seq-" + ctr },
        { $inc: { v: 1 } },
        { upsert: true, returnUpdatedDocs: true },
      )
    ).affectedDocuments.v;
    const bill = await db.bills.insertAsync({
      counter: ctr,
      no: `INV/${fy()}/${ctr}-${String(seq).padStart(6, "0")}`,
      date: today(),
      at: new Date().toISOString(),
      customer: customer.trim(),
      mode,
      items: lines,
      sub,
      discount: disc,
      roundOff: total - (sub - disc),
      total,
      status: "COMPLETED",
      by: req.user.username,
    });
    for (const l of lines)
      await db.products.updateAsync(
        { _id: l.productId },
        { $inc: { stock: -l.qty } },
      );
    await audit(req.user.username, "Bill Created", bill.no);
    res.json(bill);
  }),
);
app.get(
  "/api/bills",
  auth(),
  A(async (req, res) => {
    const q = { date: req.query.date || today() };
    if (req.user.role !== "MANAGER") q.by = req.user.username;
    res.json(
      (await db.bills.findAsync(q)).sort((a, b) => b.at.localeCompare(a.at)),
    );
  }),
);
app.post(
  "/api/bills/:id/cancel",
  auth("MANAGER"),
  A(async (req, res) => {
    const b = await db.bills.findOneAsync({ _id: req.params.id });
    if (!b || b.status !== "COMPLETED") throw new Error("Cannot cancel");
    if (!req.body.reason) throw new Error("Reason required");
    for (const l of b.items)
      await db.products.updateAsync(
        { _id: l.productId },
        { $inc: { stock: l.qty } },
      );
    await db.bills.updateAsync(
      { _id: b._id },
      { $set: { status: "CANCELLED", cancelReason: req.body.reason } },
    );
    await audit(
      req.user.username,
      "Bill Cancelled",
      b.no + " " + req.body.reason,
    );
    res.json({ ok: true });
  }),
);
app.get(
  "/api/summary",
  auth("MANAGER"),
  A(async (req, res) => {
    const B = await db.bills.findAsync({
        date: req.query.date || today(),
        status: "COMPLETED",
      }),
      s = { sales: 0, bills: B.length, CASH: 0, UPI: 0, CREDIT: 0, kg: 0 };
    B.forEach((b) => {
      s.sales += b.total;
      s[b.mode] += b.total;
      b.items.forEach((i) => {
        if (i.unit === "KG") s.kg += i.qty;
      });
    });
    res.json(s);
  }),
);
app.get(
  "/api/audit",
  auth("MANAGER"),
  A(async (req, res) =>
    res.json(
      (await db.audit.findAsync({}))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 100),
    ),
  ),
);

app.get("/api/scale/stream", auth(), (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify(scale)}\n\n`);
  req.on("close", () => clients.delete(res));
});
app.get("/api/scale/config", auth("MANAGER"), (req, res) =>
  res.json({ cfg, status: scale }),
);
app.get(
  "/api/scale/ports",
  auth("MANAGER"),
  A(async (req, res) =>
    res.json(
      (await SerialPort.list()).map((p) => ({
        path: p.path,
        name: p.manufacturer || "",
      })),
    ),
  ),
);
app.post(
  "/api/scale/config",
  auth("MANAGER"),
  A(async (req, res) => {
    cfg = {
      ...cfg,
      ...req.body,
      mode: req.body.mode === "serial" ? "serial" : "mock",
    };
    fs.writeFileSync(path.join(DIR, "scale.json"), JSON.stringify(cfg));
    await applyScale();
    res.json({ ok: true });
  }),
);
app.post("/api/scale/mock", auth("MANAGER"), (req, res) => {
  if (cfg.mode !== "mock")
    return res.status(400).json({ error: "Not in mock mode" });
  scale.grams = Math.max(0, Math.round(+req.body.grams || 0));
  scale.stable = req.body.stable !== false;
  scale.pcs = req.body.pcs != null ? Math.round(+req.body.pcs) : null;
  push();
  res.json({ ok: true });
});
app.use(express.static(path.join(__dirname, "..", "client", "dist")));
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "..", "client", "dist", "index.html")),
);

async function seed() {
  let s = await db.settings.findOneAsync({ _id: "secret" });
  if (!s) {
    s = { _id: "secret", v: crypto.randomBytes(32).toString("hex") };
    await db.settings.insertAsync(s);
  }
  SECRET = s.v;
  const seedUsers = CLOUD
    ? [["manager", process.env.ADMIN_PASSWORD || "", "MANAGER", "Owner"]]
    : [
        ["manager", "manager123", "MANAGER", "Shop Manager"],
        ["operator", "operator123", "OPERATOR", "Counter Operator"],
      ];
  if (
    CLOUD &&
    !(await db.users.countAsync({})) &&
    (process.env.ADMIN_PASSWORD || "").length < 8
  )
    throw new Error(
      "Set ADMIN_PASSWORD (min 8 characters) for the first cloud start",
    );
  if (!(await db.users.countAsync({})))
    for (const [u, p, r, n] of seedUsers)
      await db.users.insertAsync({
        username: u,
        pass: bcrypt.hashSync(p, 10),
        role: r,
        name: n,
        active: true,
      });
  if (!(await db.products.countAsync({})))
    for (const [name, unit, rate, unitWeight, stock] of [
      ["Tomato", "KG", 3200, 0, 500000],
      ["Onion", "KG", 2800, 0, 500000],
      ["Potato", "KG", 2400, 0, 500000],
      ["Garlic", "KG", 16000, 0, 100000],
      ["Lemon", "PCS", 500, 80, 2000],
      ["Banana", "PCS", 600, 120, 1000],
    ])
      await db.products.insertAsync({
        name,
        unit,
        rate,
        unitWeight,
        stock,
        code: "",
        active: true,
      });
}
async function start(port = 4310, host = "127.0.0.1") {
  if (CLOUD && MODE !== "counter") await useMongo(process.env.MONGO_URI);
  if (MODE !== "counter") {
    await seed();
    if (!CLOUD) {
      backup();
      setInterval(backup, 6 * 3600e3);
    }
  }
  try {
    cfg = {
      ...cfg,
      ...JSON.parse(fs.readFileSync(path.join(DIR, "scale.json"), "utf8")),
    };
  } catch (e) {}
  await applyScale();
  return new Promise((r) => app.listen(port, host, () => r(port)));
}
async function resetAdmin(pw) {
  if (!pw || pw.length < 8)
    throw new Error("ADMIN_PASSWORD must be at least 8 characters");
  const pass = bcrypt.hashSync(pw, 10),
    u = await db.users.findOneAsync({ username: "manager" });
  if (u)
    await db.users.updateAsync(
      { _id: u._id },
      { $set: { pass, active: true, role: "MANAGER" } },
    );
  else
    await db.users.insertAsync({
      username: "manager",
      pass,
      role: "MANAGER",
      name: "Owner",
      active: true,
    });
}
module.exports = { start, onLine, resetAdmin };
if (require.main === module)
  start(+process.env.PORT || 4310, process.env.HOST || "127.0.0.1").then((p) =>
    console.log("Billing server: http://127.0.0.1:" + p),
  );
