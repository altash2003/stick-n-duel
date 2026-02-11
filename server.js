require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);

/* -------------------- CONFIG -------------------- */
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ✅ IMPORTANT FOR RAILWAY: Do NOT fallback to localhost
if (!MONGO_URL) {
  console.error("❌ Missing MONGO_URL env var. Add it in Railway Variables.");
  process.exit(1);
}

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors()); // if you have a specific frontend domain, lock this down
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- MODELS -------------------- */
// If you already have a separate User model file, remove this section
// and import it instead.
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, minlength: 5, maxlength: 12 },
    passwordHash: { type: String, required: true },
    tcBalance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  { collection: "users" }
);

const User = mongoose.model("User", userSchema);

/* -------------------- HELPERS -------------------- */
function validateUsername(username) {
  // 5–12 chars, letters+numbers only
  return /^[A-Za-z0-9]{5,12}$/.test(username);
}

function validatePassword(password) {
  // 5–12 chars, any characters allowed
  return typeof password === "string" && password.length >= 5 && password.length <= 12;
}

/* -------------------- ROUTES -------------------- */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// SIGN UP
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!validateUsername(username)) {
      return res.status(400).json({ error: "Username must be 5-12 chars, letters/numbers only." });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: "Password must be 5-12 chars." });
    }

    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: "Username already exists." });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      passwordHash,
      tcBalance: 0
    });

    return res.status(201).json({
      ok: true,
      user: { id: user._id, username: user.username, tcBalance: user.tcBalance }
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!validateUsername(username) || !validatePassword(password)) {
      return res.status(400).json({ error: "Invalid username/password format." });
    }

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: "Invalid credentials." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });

    const token = jwt.sign(
      { uid: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      ok: true,
      token,
      user: { id: user._id, username: user.username, tcBalance: user.tcBalance }
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* -------------------- STARTUP -------------------- */
async function start() {
  try {
    await mongoose.connect(MONGO_URL, {
      // These are safe defaults; Mongoose v7+ doesn’t need extra flags
      serverSelectionTimeoutMS: 15000
    });
    console.log("✅ MongoDB connected");

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Mongo startup failed:", err);
    process.exit(1);
  }
}

start();
