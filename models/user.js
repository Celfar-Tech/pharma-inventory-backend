const db = require("../database"); // Imports your database connection wrapper

class User {
  // 🌟 1. Added `role` as the first parameter to match your controller
  constructor(role, fullname, username, email, passwordHash) {
    // Gracefully split fullname into first_name and last_name for your schema
    const nameParts = fullname ? fullname.trim().split(/\s+/) : [""];
    this.first_name = nameParts[0] || "";
    this.last_name = nameParts.slice(1).join(" ") || "";

    this.username = username;
    this.email = email;
    this.password_hash = passwordHash;

    // 🌟 2. Assign the role from the frontend, with 'patient' as a safe fallback
    this.role = role || "pharmacist"; // Default role is 'pharmacist' if not provided
  }

  // Used by your signUp controller
  async create_user() {
    const query = `
      INSERT INTO pharma.users (role, email, password_hash, username, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id AS id, username, email, role;
    `;
    const values = [this.role, this.email, this.password_hash, this.username, this.first_name, this.last_name];

    try {
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw err; // Throws the error up to your controller's catch block (e.g., code 23505)
    }
  }

  // Used to fetch the logged-in user's profile
  static async findById(id) {
    const query = `
      SELECT user_id AS id, username, email, role, first_name, last_name, phone_number, license_number, status 
      FROM pharma.users 
      WHERE user_id = $1;
    `;
    try {
      const result = await db.query(query, [id]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used when provisioning a Google account, whose username is derived from the
  // email address and therefore must be checked for collisions first.
  static async findByUsername(username) {
    const query = `SELECT 1 FROM pharma.users WHERE username = $1 LIMIT 1;`;

    try {
      const result = await db.query(query, [username]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used by your logIn controller
  static async findOne(email) {
    // Aliasing user_id -> id and password_hash -> password keeps it compatible with your controller
    const query = `
      SELECT user_id AS id, username, email, password_hash AS password, role 
      FROM pharma.users 
      WHERE email = $1;
    `;

    try {
      const result = await db.query(query, [email]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }

  // Used by your logIn controller tracking metrics
  static async logged_in(email) {
    const query = `
      UPDATE pharma.users 
      SET updated_at = CURRENT_TIMESTAMP 
      WHERE email = $1;
    `;

    try {
      await db.query(query, [email]);
      return true;
    } catch (err) {
      console.error("Failed to update user login metric:", err);
      return false; // Soft fail so database metrics don't disrupt user login access
    }
  }

  static async updatePassword(email, passwordHash) {
    const query = `
      UPDATE pharma.users
      SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
      WHERE email = $2
      RETURNING user_id AS id, username, email, role;
    `;

    try {
      const result = await db.query(query, [passwordHash, email]);
      return result.rows[0] || null;
    } catch (err) {
      throw err;
    }
  }
}

module.exports = User;