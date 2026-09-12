require("dotenv").config();

const express = require("express");
const userRoutes = require("./routes/user");
const medicineRoutes = require("./routes/medicine");
const manufacturerRoutes = require("./routes/manufacturer");
const inventoryRoutes = require("./routes/inventory");
const billingRoutes = require("./routes/billing");
const app = express();
const bodyParser = require("body-parser");
const reqAuth = require("./middleware/reqAuth");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Bind to all interfaces by default so the app is reachable from outside the VPS.
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 8080;

// When running behind Nginx/Caddy/a load balancer, trust its forwarded headers.
// Required for correct req.ip (rate limiting) and X-Forwarded-Proto awareness.
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

const conn = require("./database");
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Public auth endpoints (login/OTP/register) are unauthenticated, so throttle them.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please try again later." },
});

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(
  helmet({
    // This is a JSON API consumed by a separate frontend origin.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(express.json());
app.use(cookieParser());

app.use(cors(corsOptions));

// Simple unauthenticated probe for verifying the app is reachable from the internet.
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.use("/user/", authLimiter, userRoutes);
app.use("/medicine/", reqAuth, medicineRoutes);
app.use("/inventory/", reqAuth, inventoryRoutes);
app.use("/manufacturer/", reqAuth, manufacturerRoutes);
app.use("/billing/", reqAuth, billingRoutes);
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 Application Started at http://${HOST}:${PORT}/ (reachable via the VPS public IP)`);
});
