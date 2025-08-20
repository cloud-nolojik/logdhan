export const validateUser = (userData) => {
  const errors = {};

  // Validate name
  if (!userData.firstName) {
    errors.firstName = 'First name is required';
  } else if (typeof userData.firstName !== 'string') {
    errors.firstName = 'First name must be a string';
  } else if (userData.firstName.trim().length < 1) {
    errors.firstName = 'First name cannot be empty';
  }

  if (!userData.lastName) {
    errors.lastName = 'Last name is required';
  } else if (typeof userData.lastName !== 'string') {
    errors.lastName = 'Last name must be a string';
  } else if (userData.lastName.trim().length < 1) {
    errors.lastName = 'Last name cannot be empty';
  }

  if (!userData.email) {
    errors.email = 'Email is required';
  } else if (!validateEmail(userData.email)) {
    errors.email = 'Please enter a valid email address';
  }

  // // Validate mobile number
  // if (!userData.mobileNumber) {
  //   errors.mobileNumber = 'Mobile number is required';
  // } else if (!/^\d{12}$/.test(userData.mobileNumber)) {
  //   errors.mobileNumber = 'Please enter a valid 12-digit mobile number';
  // }

  return {
    errors,
    isValid: Object.keys(errors).length === 0
  };
};

export const validateOTP = (otpData) => {
  const errors = {};

  // Validate mobile number
  if (!otpData.mobileNumber) {
    errors.mobileNumber = 'Mobile number is required';
  } else if (!/^\d{10}$/.test(otpData.mobileNumber)) {
    errors.mobileNumber = 'Please enter a valid 10-digit mobile number';
  }

  // Validate OTP
  if (!otpData.otp) {
    errors.otp = 'OTP is required';
  } else if (!/^\d{6}$/.test(otpData.otp)) {
    errors.otp = 'Please enter a valid 6-digit OTP';
  }

  return {
    errors,
    isValid: Object.keys(errors).length === 0
  };
};

export const validateStock = (stockData) => {
  const errors = {};

  // Validate instrument_key
  if (!stockData.instrument_key) {
    errors.instrument_key = 'Instrument key is required';
  } else if (typeof stockData.instrument_key !== 'string') {
    errors.instrument_key = 'Instrument key must be a string';
  }

  return {
    errors,
    isValid: Object.keys(errors).length === 0
  };
};

export const validateStockLog = (logData) => {
  const errors = {};

  // Validate instrument_key
  if (!logData.instrument_key) {
    errors.instrument_key = 'Instrument key is required';
  } else if (typeof logData.instrument_key !== 'string') {
    errors.instrument_key = 'Instrument key must be a string';
  }

  // Validate direction
  if (!logData.direction) {
    errors.direction = 'Trade direction is required';
  } else if (!['BUY', 'SELL'].includes(logData.direction.toUpperCase())) {
    errors.direction = 'Trade direction must be either BUY or SELL';
  }

  // Validate quantity
  if (logData.quantity === undefined || logData.quantity === null) {
    errors.quantity = 'Quantity is required';
  } else if (typeof logData.quantity !== 'number' || logData.quantity <= 0) {
    errors.quantity = 'Quantity must be a positive number';
  }

  // Validate entry price
  if (logData.entryPrice === undefined || logData.entryPrice === null) {
    errors.entryPrice = 'Entry price is required';
  } else if (typeof logData.entryPrice !== 'number' || logData.entryPrice <= 0) {
    errors.entryPrice = 'Entry price must be a positive number';
  }

  // Validate target price
  if (logData.targetPrice !== undefined && (typeof logData.targetPrice !== 'number' || logData.targetPrice <= 0)) {
    errors.targetPrice = 'Target price must be a positive number';
  }

  // Validate stop loss
  if (logData.stopLoss !== undefined && (typeof logData.stopLoss !== 'number' || logData.stopLoss <= 0)) {
    errors.stopLoss = 'Stop loss must be a positive number';
  }

  // Validate term
  if (!logData.term) {
    errors.term = 'Trading term is required';
  } else if (!['intraday', 'short', 'medium', 'long'].includes(logData.term.toLowerCase())) {
    errors.term = 'Term must be one of: intraday, short, medium, long';
  }

  // Validate reasoning (optional, but must be string if present and within length limit)
  if (logData.reasoning !== undefined && logData.reasoning !== null) {
    if (typeof logData.reasoning !== 'string') {
      errors.reasoning = 'Reasoning must be a string';
    } else if (logData.reasoning.length > 2000) {
      errors.reasoning = 'Reasoning cannot exceed 2000 characters';
    }
  }

  // Validate needsReview (optional, but must be boolean if present)
  if (logData.needsReview !== undefined && typeof logData.needsReview !== 'boolean') {
    errors.needsReview = 'needsReview must be a boolean value';
  }

  return {
    errors,
    isValid: Object.keys(errors).length === 0
  };
};

const validateEmail = (email) => {
  const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
};

const validatePassword = (password) => {
  // At least 6 characters, 1 uppercase, 1 lowercase, 1 number
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/;
  return re.test(password);
};

const sanitizeInput = (input) => {
  return input.trim().replace(/[<>]/g, '');
};

export { validateEmail, validatePassword, sanitizeInput }; 