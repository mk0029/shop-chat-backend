# Shop Chat Backend

Realtime customer-admin chat service for the Shop App.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

The frontend should set `NEXT_PUBLIC_SHOP_CHAT_URL` to this service URL, for example `http://localhost:5050`.

## Auth

The service accepts the existing Shop App `auth-storage` Zustand cookie payload through `X-Shop-Auth`, `Authorization: ShopAuth <payload>`, a cookie, or Socket.IO `auth.authStorage`. It then verifies the user against Sanity before allowing API/socket access.
