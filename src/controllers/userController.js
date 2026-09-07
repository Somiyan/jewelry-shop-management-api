const asyncHandler = require('express-async-handler');
const User = require('../models/User');

const ALLOWED_ROLES = ['admin', 'staff', 'manager'];

const createUser = asyncHandler(async (req, res) => {
  const { username, email, password, role, permissions } = req.body;
  if (!username || !email || !password) {
    res.status(400);
    throw new Error('username, email and password are required');
  }
  if (role && !ALLOWED_ROLES.includes(role)) {
    res.status(400);
    throw new Error(`role must be one of: ${ALLOWED_ROLES.join(', ')}`);
  }
  const exists = await User.findOne({ $or: [{ username }, { email }] });
  if (exists) {
    res.status(409);
    throw new Error('Username or email already in use');
  }
  const user = await User.create({ username, email, password, role, permissions });
  res.status(201).json(user);
});

const getUsers = asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.json(users);
});

module.exports = { createUser, getUsers };
