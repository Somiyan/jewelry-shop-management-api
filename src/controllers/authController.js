const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  });
}

const register = asyncHandler(async (req, res) => {
  const { username, email, password, role, permissions } = req.body;
  if (!username || !email || !password) {
    res.status(400);
    throw new Error('username, email and password are required');
  }
  const exists = await User.findOne({ $or: [{ username }, { email }] });
  if (exists) {
    res.status(409);
    throw new Error('Username or email already in use');
  }
  const user = await User.create({ username, email, password, role, permissions });
  res.status(201).json({ user, token: signToken(user) });
});

const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ $or: [{ username }, { email: username }] });
  if (!user || !(await user.comparePassword(password))) {
    res.status(401);
    throw new Error('Invalid credentials');
  }
  res.json({ user, token: signToken(user) });
});

const logout = asyncHandler(async (req, res) => {
  res.json({ message: 'Logged out. Discard the token client-side.' });
});

module.exports = { register, login, logout };
