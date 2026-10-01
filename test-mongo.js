const fs = require("fs");
for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !l.trim().startsWith("#"))
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (
  !process.env.MONGO_URI ||
  /xxxxx|USER:PASSWORD/.test(process.env.MONGO_URI)
) {
  console.log(
    "FAILED: MONGO_URI in .env is still the sample text. Paste your real Atlas connection string.",
  );
  process.exit(1);
}
if (
  /^mongodb\+srv:/.test(process.env.MONGO_URI) &&
  process.env.DNS_SERVERS !== "system"
)
  require("dns").setServers(
    (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1,8.8.4.4").split(","),
  );
require("mongodb")
  .MongoClient.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  })
  .then((c) => {
    console.log("MONGO CONNECTED - cloud database is reachable");
    return c.close();
  })
  .catch((e) => {
    console.log("MONGO FAILED:", e.message);
    console.log(
      "Hints: bad auth = wrong user/password | ENOTFOUND = wrong cluster address | timeout = Atlas Network Access must allow your IP (0.0.0.0/0) | querySrv ECONNREFUSED = DNS blocked, see SETUP.md",
    );
  });
