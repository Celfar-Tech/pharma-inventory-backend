# Pharma Inventory Backend

Backend for Pharma Inventory app with comprehensive API endpoints for medicine management and inventory operations.

## Documentation

- [API Documentation](./ENDPOINT_DOCUMENTATION.md) - Complete API reference for medicine search and user management
- [Inventory API Documentation](./INVENTORY_API_DOCUMENTATION.md) - Detailed documentation for inventory management endpoints
- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md) - Technical overview and implementation details

## Features

- User authentication (sign up and login)
- Medicine management (add medicines to inventory)
- Inventory tracking with stock management
- Medicine name search functionality
- PostgreSQL database integration (self-hosted on the same VPS)
- CORS enabled for cross-origin requests

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
