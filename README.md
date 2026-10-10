# Pharma Inventory Backend

Backend for Pharma Inventory app with comprehensive API endpoints for medicine management and inventory operations.

## Documentation

- [API Documentation](./ENDPOINT_DOCUMENTATION.md) - Complete API reference for medicine search and user management
- [Inventory API Documentation](./INVENTORY_API_DOCUMENTATION.md) - Detailed documentation for inventory management endpoints
- [Dashboard Revenue Analytics & AI-Agent Tools](./controllers/DASHBOARD_AGENT_TOOLS.md) - Sales-revenue analytics endpoints and the agent tool manifest
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md) - Technical overview and implementation details

## Features

- User authentication (sign up and login)
- Medicine management (add medicines to inventory)
- Inventory tracking with stock management
- Medicine name search functionality
- PostgreSQL database integration (self-hosted on the same VPS)
- CORS enabled for cross-origin requests
- Dashboard revenue analytics (monthly / weekly / custom range) with AI-agent tool definitions

## Quick Start

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (create a `.env` file):
   ```env
   DB_USER=pharma_bot
   DB_HOST=localhost
   DB_DATABASE=pharma
   DB_PASSWORD=your_db_password
   DB_PORT=5432
   DB_SSL=false
   ```

   This project uses **PostgreSQL**. In production the database runs on the **same VPS as the Node app**, so the app connects over `localhost` with **TLS disabled** (`DB_SSL=false`). TLS is opt-in: set `DB_SSL=true` only when connecting to a remote/managed Postgres over the network. Optionally set `DATABASE_URL` to a full connection string; it takes precedence over the individual `DB_*` variables, and its password must be URL-encoded.

4. Start the server:
   ```bash
   npm start
   ```

The server will be available at `http://localhost:8080/`

## Order Book API

Use the backend port (`8080`) in Postman. The server supports both the documented
`/api` URLs and the original URLs without the prefix.

1. Log in with `POST http://localhost:8080/api/user/login` and a JSON body:
   ```json
   { "email": "your-email@example.com", "password": "your-password" }
   ```
2. Copy the `token` from the response and send it on book requests as
   `Authorization: Bearer <token>`. Browser clients can continue using the
   HTTP-only session cookie set during login.
3. Use `GET http://localhost:8080/api/book/entries` to retrieve the signed-in
   user's order book.

Book endpoints (`/api/book`):

- `GET /entries` - list active order book entries
- `GET /history` - list previously placed orders, one summary row per
  `book_ledger` (ledger id, date, supplier, item count, approximate cost). The
  ordered medicines are not included here.
- `GET /history/:ledgerId` - expand one placed order: returns its ledger summary
  plus every `book_items` line linked to that `ledger_id`. Scoped to the signed-in
  user; an unknown ledger id returns `404`.
- `POST /upsert` - add an entry (JSON: `name`, `quantity`; optional medicine details).
  Adding, editing, removing or clearing entries only touches `book_items`; no row is
  inserted into or updated in `book_ledger`.
- `PUT /:id` - update an active entry
- `DELETE /:id` - remove an active entry
- `DELETE /clear` - clear active entries
- `POST /place-order` - move selected entries to order history (JSON: `ids`). Each
  call creates one new `book_ledger` row and stamps the selected entries with that
  `ledger_id`; entries keep `ledger_id = NULL` until an order is placed.

## API Usage Examples

### Add medicine to inventory:
```bash
curl -X POST http://localhost:8080/inventory/add-medicine \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Paracetamol 500mg",
    "manufacturer_name": "Genericart",
    "type": "Tablet",
    "pack_size_label": "10 tablets",
    "mrp": 45.50,
    "stock_quantity": 200
  }'
```

### Search for medicines:
```bash
curl "http://localhost:8080/medicine/medicine-name?name=Paracetamol"
``` 
### Linting using biome
sample command
```
npx @biomejs/biome format --write .\models\
OR
npm run lint:fix
```
