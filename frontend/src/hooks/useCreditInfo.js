import { useState, useEffect } from 'react';
import { creditAPI } from '../services/api';

export const useCreditInfo = () => {
  const [creditInfo, setCreditInfo] = useState({
    aiReviewCost: 1,
    creditValidityMonths: 6,
    description: '1 AI Review = 1 Credit'
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchCreditInfo = async () => {
      try {
        setLoading(true);
        const info = await creditAPI.getPublicCreditInfo();
        setCreditInfo(info);
        setError(null);
      } catch (err) {
        setError(err.message);
        // Keep fallback values if error occurs
      } finally {
        setLoading(false);
      }
    };

    fetchCreditInfo();
  }, []);

  return { creditInfo, loading, error };
};