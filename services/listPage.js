module.exports = async (collection, filter, req, sort, projection) => {
  const page = Math.max(
    1,
    Math.min(1000000, Math.floor(Number(req.query.page) || 1)),
  );
  const limit = 100;
  return {
    records: await collection
      .find(filter, projection ? { projection } : {})
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    total: await collection.countDocuments(filter),
    page,
  };
};
