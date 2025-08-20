// API service for fetching credit information
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const creditAPI = {
  // Fetch public credit information
  getPublicCreditInfo: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/credits/public/info`);
      if (!response.ok) {
        throw new Error('Failed to fetch credit information');
      }
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('Error fetching credit info:', error);
      // Return fallback data if API fails
      return {
        aiReviewCost: 1,
        creditValidityMonths: 6,
        description: '1 AI Review = 1 Credit'
      };
    }
  }
};