require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');

const Volunteer = require('./Volunteer');
const NeedRequest = require('./NeedRequest');
const EmailVerification = require('./EmailVerification');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/community_connect';
const emailApiKey = process.env.EMAIL_API_KEY;
const emailApiSecret = process.env.EMAIL_API_SECRET;
const emailApiUrl = process.env.EMAIL_API_URL || 'https://api.mailjet.com/v3.1/send';
const emailFrom = process.env.EMAIL_FROM || 'Community Connect <noreply@yourdomain.com>';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function sendVerificationEmail(to, code) {
  if (!emailApiKey || !emailApiSecret || !emailFrom) {
    throw new Error('Mailjet is not configured. Set EMAIL_API_KEY, EMAIL_API_SECRET, and EMAIL_FROM in your environment.');
  }

  const auth = Buffer.from(`${emailApiKey}:${emailApiSecret}`).toString('base64');
  const response = await fetch(emailApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: emailFrom.match(/<([^>]+)>/)?.[1] || emailFrom, Name: emailFrom.replace(/\s*<[^>]+>$/, '') || 'Community Connect' },
        To: [{ Email: to }],
        Subject: 'Your Community Connect verification code',
        TextPart: `Your verification code is: ${code}\nThis code expires in 10 minutes.`,
      }],
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Mailjet API Error (${response.status}): ${responseText}`);
  }

  return responseText;
}

async function requireVerifiedEmail(email, purpose) {
  const verification = await EmailVerification.findOne({
    email: normalizeEmail(email),
    purpose,
    verifiedAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
  }).sort({ verifiedAt: -1 });
  return Boolean(verification);
}

app.post('/api/verification/send', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const purpose = req.body?.purpose;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    const allowedPurposes = ['volunteer-registration', 'requester-action', 'volunteer-action'];
    if (!allowedPurposes.includes(purpose)) {
      return res.status(400).json({ error: 'Invalid verification purpose.' });
    }

    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 12);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await EmailVerification.findOneAndUpdate(
      { email, purpose },
      { email, purpose, codeHash, expiresAt, verifiedAt: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await sendVerificationEmail(email, code);
    res.json({ message: 'Verification code sent.' });
  } catch (err) {
    console.error('OTP email delivery failed:', err.message);
    res.status(503).json({ error: err.message });
  }
});

app.post('/api/verification/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const purpose = req.body?.purpose;
    const code = String(req.body?.code || '').trim();

    if (!email || !purpose || !code) {
      return res.status(400).json({ error: 'Email, purpose, and code are required.' });
    }

    const verification = await EmailVerification.findOne({
      email,
      purpose,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!verification) {
      return res.status(400).json({ error: 'Verification code expired or not found.' });
    }

    const isValid = await bcrypt.compare(code, verification.codeHash);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    verification.verifiedAt = new Date();
    await verification.save();

    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Volunteers ---

app.post('/api/volunteers', async (req, res) => {
  try {
    const { password, ...profile } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const volunteer = await Volunteer.create({
      ...profile,
      email: String(profile.email || '').toLowerCase().trim(),
      passwordHash: await bcrypt.hash(password, 12),
    });
    const safeVolunteer = volunteer.toObject();
    delete safeVolunteer.passwordHash;
    res.status(201).json(safeVolunteer);
  } catch (err) {
    const error = err.code === 11000 ? 'An account with this email already exists.' : err.message;
    res.status(400).json({ error });
  }
});

app.post('/api/volunteers/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const { password } = req.body;
    const volunteer = await Volunteer.findOne({ email }).select('+passwordHash');

    if (!volunteer || !password || !(await bcrypt.compare(password, volunteer.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const safeVolunteer = volunteer.toObject();
    delete safeVolunteer.passwordHash;
    res.json({ volunteer: safeVolunteer });
  } catch (err) {
    res.status(500).json({ error: 'Unable to sign in right now.' });
  }
});

app.put('/api/volunteers/:volunteerId', async (req, res) => {
  try {
    const { name, email, password, availability, location, bio } = req.body;
    const updates = { name, email: String(email || '').toLowerCase().trim(), availability, location, bio };
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      updates.passwordHash = await bcrypt.hash(password, 12);
    }

    const volunteer = await Volunteer.findByIdAndUpdate(
      req.params.volunteerId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
    const safeVolunteer = volunteer.toObject();
    delete safeVolunteer.passwordHash;
    res.json({ volunteer: safeVolunteer });
  } catch (err) {
    const error = err.code === 11000 ? 'An account with this email already exists.' : err.message;
    res.status(400).json({ error });
  }
});

app.get('/api/volunteers', async (req, res) => {
  const volunteers = await Volunteer.find();
  res.json(volunteers);
});

app.get('/api/volunteers/:volunteerId/nearby-requests', async (req, res) => {
  try {
    const volunteer = await Volunteer.findById(req.params.volunteerId).select('-passwordHash');
    if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });

    const locationPattern = String(volunteer.location).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const requests = await NeedRequest.find({
      location: { $regex: `^${locationPattern}$`, $options: 'i' },
      status: 'pending',
      matchedVolunteer: { $exists: false },
    }).lean();
    const acceptedRequests = await NeedRequest.find({
      matchedVolunteer: volunteer._id,
      status: 'matched',
    }).lean();
    const completedRequests = await NeedRequest.find({
      matchedVolunteer: volunteer._id,
      status: 'resolved',
    }).lean();
    const availableRequests = requests.filter((request) => !(request.volunteerResponses || []).some(
      (response) => String(response.volunteer) === String(volunteer._id)
    ));

    const payload = JSON.stringify({
      mode: 'requests',
      volunteer,
      requests: availableRequests,
    });
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    const python = spawn(pythonCommand, [path.join(__dirname, 'match.py')]);
    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => (output += data.toString()));
    python.stderr.on('data', (data) => (errorOutput += data.toString()));
    python.on('close', (code) => {
      if (code !== 0) return res.status(500).json({ error: 'ML request matching failed.', details: errorOutput });
      try {
        res.json({ ...JSON.parse(output), acceptedRequests, completedRequests });
      } catch (err) {
        res.status(500).json({ error: 'Invalid response from ML request matching.' });
      }
    });
    python.stdin.write(payload);
    python.stdin.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests/:requestId/respond', async (req, res) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    const { volunteerId, action, reason } = req.body;

    if (!requestId || requestId === 'undefined' || requestId === 'null') {
      return res.status(400).json({ error: 'Request id is missing.' });
    }
    if (!volunteerId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'A volunteer and valid action are required.' });
    }

    const [request, volunteer] = await Promise.all([
      NeedRequest.findById(requestId),
      Volunteer.findById(volunteerId),
    ]);
    if (!request || !volunteer) return res.status(404).json({ error: 'Request or volunteer not found.' });
    if (!(await requireVerifiedEmail(volunteer.email, 'volunteer-action'))) {
      return res.status(403).json({ error: 'Verify your volunteer email before responding.' });
    }
    if (request.location.toLowerCase().trim() !== volunteer.location.toLowerCase().trim()) {
      return res.status(403).json({ error: 'Only volunteers near this request can respond.' });
    }
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request is no longer available.' });
    if (request.volunteerResponses.some((response) => String(response.volunteer) === String(volunteerId))) {
      return res.status(409).json({ error: 'You have already responded to this request.' });
    }

    request.volunteerResponses.push({ volunteer: volunteerId, decision: action === 'accept' ? 'accepted' : 'rejected', reason });
    if (action === 'accept') {
      request.matchedVolunteer = volunteerId;
      request.status = 'matched';
    }
    await request.save();
    res.json({ message: action === 'accept' ? 'Request accepted.' : 'Request rejected.', request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests/:requestId/complete', async (req, res) => {
  try {
    const { volunteerId, completionNote } = req.body;
    const request = await NeedRequest.findById(req.params.requestId)
      .populate('matchedVolunteer', 'name email location');
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (!(await requireVerifiedEmail(request.matchedVolunteer.email, 'volunteer-action'))) {
      return res.status(403).json({ error: 'Verify your volunteer email before completing this task.' });
    }
    if (!request.matchedVolunteer || String(request.matchedVolunteer._id) !== String(volunteerId)) {
      return res.status(403).json({ error: 'Only the assigned volunteer can complete this request.' });
    }
    if (request.status !== 'matched') return res.status(409).json({ error: 'This request is not active.' });

    request.status = 'resolved';
    request.completedAt = new Date();
    request.completedLocation = request.location;
    request.completionNote = String(completionNote || '').trim();
    await request.save();
    res.json({
      message: 'Help request completed.',
      request: {
        id: request._id,
        requesterName: request.requesterName,
        volunteerName: request.matchedVolunteer.name,
        helpType: request.category || 'general help',
        location: request.completedLocation || request.location,
        completedAt: request.completedAt,
        completionNote: request.completionNote,
      },
    });
  } catch (err) {
    console.error('OTP email delivery failed:', err.message);

    res.status(503).json({
      error: err.message
    });
  }
});

// --- Need requests ---

app.post('/api/requests', async (req, res) => {
  try {
    const requesterEmail = normalizeEmail(req.body?.requesterEmail);
    if (!requesterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) {
      return res.status(400).json({ error: 'A valid requester email is required.' });
    }
    if (!(await requireVerifiedEmail(requesterEmail, 'requester-action'))) {
      return res.status(403).json({ error: 'Verify your email before posting a request.' });
    }
    const request = await NeedRequest.create({ ...req.body, requesterEmail });
    res.status(201).json(request);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/requests', async (req, res) => {
  const requests = await NeedRequest.find();
  res.json(requests);
});

app.get('/api/requests/:requestId/status', async (req, res) => {
  try {
    const request = await NeedRequest.findById(req.params.requestId)
      .populate('matchedVolunteer', 'name email location')
      .populate('volunteerResponses.volunteer', 'name location');
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    res.json({
      status: request.status,
      matchedVolunteer: request.matchedVolunteer,
      volunteerResponses: request.volunteerResponses,
      completedAt: request.completedAt,
      completedLocation: request.completedLocation || request.location,
      completionNote: request.completionNote,
      helpType: request.helpType || request.category || 'general help',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Matching: calls the Python ML script ---

app.post('/api/match/:requestId', async (req, res) => {
  try {
    const request = await NeedRequest.findById(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const volunteers = await Volunteer.find();

    const payload = JSON.stringify({ request, volunteers });
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    const python = spawn(pythonCommand, [path.join(__dirname, 'match.py')]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => (output += data.toString()));
    python.stderr.on('data', (data) => (errorOutput += data.toString()));

    python.on('close', async (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: 'ML matching failed', details: errorOutput });
      }
      try {
        const result = JSON.parse(output);

        request.category = result.category;
        request.urgency = result.urgency;
        await request.save();

        res.json({ request, ...result });
      } catch (err) {
        res.status(500).json({ error: 'Invalid response from ML matching service.' });
      }
    });

    python.stdin.write(payload);
    python.stdin.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

const PORT = process.env.PORT || 7860;

async function startServer() {
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected to MongoDB');
    app.listen(PORT, "0.0.0.0", () => console.log(`Community Connect API running on port ${PORT}`));
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

startServer();