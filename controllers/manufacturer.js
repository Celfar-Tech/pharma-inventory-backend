const Manufacturer  = require("../models/manufacturer");

exports.searchManufacturerNames = async (req, res, next) => {
  const searchTerm = req.query.name;

  // Validate search term length
  if (!searchTerm || searchTerm.trim().length < 3) {
    return res.status(400).json({
      success: false,
      message: "Search term must be at least 3 characters long",
      data: [],
    });
  }

  try {
    const response = await Manufacturer.searchManufacturerNames(searchTerm);
    const manufacturers = response || [];

    if (manufacturers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No manufacturers found matching "${searchTerm}"`,
        data: [],
       
      });
    }

    return res.status(200).json({
      success: true,
      message: `Found ${manufacturers.length} manufacturer(s) matching "${searchTerm}"`,
      data: manufacturers,
     
    });
  } catch (err) {
    console.error(`Manufacturer search error for term "${searchTerm}":`, err);
    return res.status(500).json({ 
      error: "Internal server error",
      errorId: Date.now()
    });
  }
};
