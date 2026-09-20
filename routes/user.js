const express = require("express");
const router = express.Router();
const userController = require("../controllers/user");
const reqAuth = require("../middleware/reqAuth");

router.post("/send-otp", userController.sendOtp);
router.post("/verify-otp", userController.verifyOtp);
router.post("/register", userController.signUp);
router.post("/forgot-password/request-otp", userController.requestPasswordResetOtp);
router.post("/forgot-password/verify-otp", userController.verifyPasswordResetOtp);
router.post("/forgot-password/reset", userController.resetPassword);

// Route for User Login
router.post("/login", userController.logIn);
router.post("/logout", reqAuth, userController.logOut);

// Fetch the authenticated user profile (used by the frontend session bootstrap)
router.get("/profile", reqAuth, userController.getProfile);

module.exports = router;
