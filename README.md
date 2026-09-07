# jewelry-shop-management-api

Backend API for the Sonali Jewellers shop management system — Node.js + Express + MongoDB.

Handles product/stock master data with jewellery-specific pricing (purity, wastage, making
charges, live gold & silver rates), customers, orders (including made-to-order items),
sales checkout, invoicing with PDF generation, and financial transactions.

## Requirements

- Node.js 18+
- MongoDB (local or Atlas)

## Setup

```bash
npm install
cp .env.example .env   # then fill in MONGO_URI and JWT_SECRET
npm run dev
```

The API listens on `PORT` (default `5050`).

## Environment

See `.env.example` for the full list. `MONGO_URI` and `JWT_SECRET` are required.

## API

All routes are mounted under `/api` and require a bearer token except `POST /api/auth/login`.

| Area | Base path |
| --- | --- |
| Auth & users | `/api/auth`, `/api/users` |
| Products & categories | `/api/products`, `/api/categories` |
| Stock | `/api/stock` |
| Metal rates & pricing | `/api/precious-metal-rates`, `/api/pricing` |
| Customers | `/api/customers` |
| Orders | `/api/orders` |
| Sales checkout | `/api/sales` |
| Invoices (incl. PDF) | `/api/invoices` |
| Financials | `/api/financials` |
| Audit log | `/api/audit-logs` |
