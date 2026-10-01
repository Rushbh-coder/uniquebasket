# Cloud setup (data stored online, not on a shop PC)
1. MongoDB Atlas (free M0): create cluster > Database Access: create user > Network Access: allow 0.0.0.0/0 >
   Connect > Drivers: copy the connection string (mongodb+srv://user:pass@cluster...).
2. Put this project on GitHub (private). On Render.com: New > Web Service > connect repo > Runtime: Docker.
   Environment variables:  MONGO_URI = <connection string>   ADMIN_PASSWORD = <strong password, 8+ chars>
3. Render gives an https address, e.g. https://unique-basket.onrender.com
4. On each counter PC: PC Setup > COUNTER PC > paste that https address > Save & Start.
   Login: manager / <ADMIN_PASSWORD>. Create operators under Users.
Test locally (needs MONGO_URI): set MONGO_URI=... & set ADMIN_PASSWORD=... & npm run cloud

## Admin from any browser
Open your Render address (https://...onrender.com) in Chrome on any PC or phone, log in on the Manager card,
and use Bills & Reports to see every counter's bills together.
