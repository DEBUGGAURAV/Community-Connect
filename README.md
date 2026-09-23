# Community Connect

Community Connect connects people requesting local help with nearby volunteers. It includes MongoDB persistence, volunteer registration and login, email OTP verification, local request matching, Google Maps links, accept/reject responses, and completion progress reports.

## Requirements

- Node.js 18 or newer
- MongoDB Atlas or local MongoDB
- Python 3.10 or newer
- SMTP account for email OTP delivery

## Setup

1. Install Node dependencies:

```powershell
npm install
```

2. Install Python dependencies if needed:

```powershell
python -m pip install -r requirements.txt
```

3. Create `.env` in the project root. Start from `.env.example`:

```powershell
Copy-Item .env.example .env
```

Update `.env` with your MongoDB and SMTP values. Never commit `.env`.

4. Start the server:

```powershell
npm start
```

5. Open the app:

```text
http://localhost:5000
```

## Docker

Build the image:

```powershell
docker build -t community-connect .
```

Run it with your local `.env` file:

```powershell
docker run --name community-connect --env-file .env -p 5000:5000 community-connect
```

Then open `http://localhost:5000`. The `.env` file is ignored and is not included in the image.

## Main Features

- User help requests stored in MongoDB.
- Volunteer registration, login, and profile editing.
- Email OTP verification before sensitive actions.
- Nearby volunteer request matching.
- Accept or reject requests.
- Google Maps location and route links.
- Complete tasks with progress notes.
- Active and completed volunteer progress views.

## GitHub Upload

The repository should include source files, `package.json`, `package-lock.json`, `requirements.txt`, `.env.example`, `.gitignore`, and this README.

Do not upload `.env`, `node_modules`, database credentials, SMTP passwords, or generated Python cache files.
