// database.js
const { Pool } = require("pg");
require("dotenv").config();

// Prefer a single DATABASE_URL if provided, otherwise build one from discrete
// DB_* variables. The app and PostgreSQL run on the same VPS, so the defaults
// point at localhost.
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${encodeURIComponent(process.env.DB_USER || "pharma_bot")}:${encodeURIComponent(
    process.env.DB_PASSWORD || ""
  )}@${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || 5432}/${
    process.env.DB_DATABASE || "pharma"
  }`;

// TLS is opt-in. A local Postgres (same VPS, Unix/localhost socket) does not
// speak TLS, so it must default to off. Set DB_SSL=true for a managed/remote DB.
const useSsl = process.env.DB_SSL === "true";
const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false";

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized } : false,
  options: process.env.DB_OPTIONS || "-c timezone=Asia/Kolkata",
  max: Number(process.env.DB_POOL_MAX) || 10,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err);
});

// Fail fast (and visibly) if the database is unreachable at boot.
pool
  .query("SELECT 1")
  .then(() => console.log("Successfully connected to PostgreSQL!"))
  .catch((err) =>
    console.error("Database connection error during initialization:", err.message)
  );

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
