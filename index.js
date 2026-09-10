
const express = require("express");
const userRoutes = require("./routes/user");
const medicineRoutes = require("./routes/medicine");
const manufacturerRoutes = require("./routes/manufacturer");
const inventoryRoutes = require("./routes/inventory");
const billingRoutes = require("./routes/billing");
const dashboardRoutes = require("./routes/dashboard");
const app = express();
const bodyParser = require("body-parser");
const PORT = `8080`;
const reqAuth = require("./middleware/reqAuth");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const conn = require("./database");
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(express.json());
app.use(cookieParser());

app.use(cors(corsOptions));

app.use("/user/", userRoutes);
app.use("/medicine/", reqAuth, medicineRoutes);
app.use("/inventory/", reqAuth, inventoryRoutes);
app.use("/manufacturer/", reqAuth, manufacturerRoutes);
app.use("/billing/", reqAuth, billingRoutes);
app.use("/dashboard/", reqAuth, dashboardRoutes);
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`🚀 Application Started at http://localhost:${PORT}/`);
});