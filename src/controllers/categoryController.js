const asyncHandler = require('express-async-handler');
const Category = require('../models/Category');

const createCategory = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  const exists = await Category.findOne({ name });
  if (exists) {
    res.status(409);
    throw new Error(`Category "${name}" already exists`);
  }
  const category = await Category.create({ name, description });
  res.status(201).json(category);
});

const listCategories = asyncHandler(async (req, res) => {
  const { active } = req.query;
  const filter = {};
  if (active === 'true') filter.isActive = true;
  if (active === 'false') filter.isActive = false;
  const categories = await Category.find(filter).sort({ name: 1 });
  res.json(categories);
});

const updateCategory = asyncHandler(async (req, res) => {
  if (req.body.name) {
    const exists = await Category.findOne({ name: req.body.name, _id: { $ne: req.params.id } });
    if (exists) {
      res.status(409);
      throw new Error(`Category "${req.body.name}" already exists`);
    }
  }
  const category = await Category.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!category) {
    res.status(404);
    throw new Error('Category not found');
  }
  res.json(category);
});

module.exports = { createCategory, listCategories, updateCategory };
