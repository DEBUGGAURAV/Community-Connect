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
const emailProvider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
const emailApiUrl = process.env.EMAIL_API_URL || (
  emailProvider === 'sendgrid'
    ? 'https://api.sendgrid.com/v3/mail/send'
    : 'https://api.resend.com/emails'
);
const emailApiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY;
const emailFrom = process.env.EMAIL_FROM || 'Community Connect <noreply@example.com>';
const httpEmailConfigured = Boolean(emailApiKey && emailFrom && !emailFrom.includes('noreply@example.com'));

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function sendEmailViaHttp({ to, subject, text, html }) {
  if (!httpEmailConfigured) {
    throw new Error('HTTP email API is not configured. Add EMAIL_API_KEY and EMAIL_FROM to .env.');
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${emailApiKey}`,
  };

  let body;
  if (emailProvider === 'sendgrid') {
    body = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: emailFrom.replace(/^.*<(.+)>$/, '$1'), name: emailFrom.replace(/<.*>/, '').trim() || 'Community Connect' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    };
  } else {
    body = {
      from: emailFrom,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    };
  }

  const response = await fetch(emailApiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Email API request failed (${response.status}): ${responseText}`);
  }

  return responseText;
}

async function sendVerificationEmail(email, code) {
  const text = `Your verification code is ${code}. It expires in 10 minutes.`;
  const html = `<p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p>`;
  await sendEmailViaHttp({
    to: email,
    subject: 'Community Connect verification code',
    text,
    html,
  });
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
    const email = normalizeEmail(req.body.email);
    const purpose = req.body.purpose;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });
    if (!['volunteer-registration', 'requester-action', 'volunteer-action'].includes(purpose)) {
      return res.status(400).json({ error: 'Invalid verification purpose.' });
    }
    if (!httpEmailConfigured) return res.status(503).json({ error: 'Email delivery is not configured. Add EMAIL_API_KEY and EMAIL_FROM to .env.' });

    const code = String(randomInt(100000, 1000000));
    const [codeHash] = await Promise.all([
      bcrypt.hash(code, 10),
      EmailVerification.deleteMany({ email, purpose, verifiedAt: { $exists: false } }),
    ]);
    await EmailVerification.create({
      email,
      purpose,
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await sendVerificationEmail(email, code);
    res.json({ message: 'Verification code sent.' });
  } catch (err) {
    console.error('OTP email delivery failed:', err.message);
    res.status(503).json({ error: 'Could not send verification code. Check EMAIL_API_KEY and EMAIL_FROM in .env.' });
  }
});

app.post('/api/verification/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { code, purpose } = req.body;
    const verification = await EmailVerification.findOne({ email, purpose, verifiedAt: { $exists: false } }).sort({ createdAt: -1 });
    if (!verification || verification.expiresAt < new Date() || !(await bcrypt.compare(String(code || ''), verification.codeHash))) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }
    verification.verifiedAt = new Date();
    await verification.save();
    res.json({ verified: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not verify email.' });
  }
});

// --- Volunteers ---

app.post('/api/volunteers', async (req, res) => {
  try {
    const { password, ...profile } = req.body;
    if (!(await requireVerifiedEmail(profile.email, 'volunteer-registration'))) {
      return res.status(403).json({ error: 'Verify your email before registering.' });
    }
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
    if (!(await requireVerifiedEmail(email, 'volunteer-action'))) {
      return res.status(403).json({ error: 'Verify your email before editing your profile.' });
    }
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
    const { volunteerId, action, reason } = req.body;
    if (!volunteerId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'A volunteer and valid action are required.' });
    }

    const [request, volunteer] = await Promise.all([
      NeedRequest.findById(req.params.requestId),
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
    res.status(500).json({ error: err.message });
  }
});

// --- Need requests ---

app.post('/api/requests', async (req, res) => {
  try {
    if (!(await requireVerifiedEmail(req.body.requesterEmail, 'requester-action'))) {
      return res.status(403).json({ error: 'Verify your email before posting a request.' });
    }
    const request = await NeedRequest.create(req.body);
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
