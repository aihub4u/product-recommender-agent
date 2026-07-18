/**
 * Suggested agent types shown during project creation, and the base system
 * prompt each maps to in the generic chat engine (src/engines/chatEngine.js).
 * "product_recommendation" is handled separately by the catalog-based
 * engine (src/engines/llmEngine.js + ruleEngine.js) since it needs product
 * matching logic, not just a system prompt.
 */
const AGENT_TYPES = [
  {
    id: 'product_recommendation',
    label: 'Product Recommendation',
    category: 'E-commerce & Retail',
    description: 'Recommends products from a catalog based on what the customer describes — occasion, budget, style. Needs a data source.',
    suggestedHasDataSource: true,
    prompt: null, // uses the catalog engine, not a static prompt
  },
  {
    id: 'faq_support',
    label: 'FAQ & Support Assistant',
    category: 'Customer Support & CX',
    description: 'Answers common questions about your business, policies, or product using instructions you provide — no catalog needed.',
    suggestedHasDataSource: false,
    prompt: 'You are a customer support assistant. Answer questions clearly and concisely, admit when you don\'t know something rather than guessing, and stay strictly within what the operator has told you about their business below.',
  },
  {
    id: 'lead_qualification',
    label: 'Lead Qualification',
    category: 'Acquisition & Activation',
    description: 'Chats with a prospect to naturally learn their need, budget/timeline, and contact details, then flags when they\'re ready for a human.',
    suggestedHasDataSource: false,
    prompt: 'You are a lead-qualification assistant. Your goal is to naturally learn the visitor\'s need, budget/timeline if relevant, and contact details, through friendly conversation — not an interrogation. Once you have enough to hand off to a human, say so clearly.',
  },
  {
    id: 'appointment_booking',
    label: 'Appointment / Booking Assistant',
    category: 'Engagement & Retention',
    description: 'Helps a customer find a time and collects the details needed to confirm a booking (e.g. clinic visits, service calls, demos).',
    suggestedHasDataSource: false,
    prompt: 'You are a booking/scheduling assistant. Help the user find a suitable time, collect the details needed to confirm a booking, and confirm back what you understood. If you cannot actually check real-time availability, say so honestly rather than inventing a slot.',
  },
  {
    id: 'order_tracking',
    label: 'Order Status & Tracking',
    category: 'Transactional Messaging',
    description: 'Handles order/delivery status questions conversationally. Pair with a data source if you want it checking real order data.',
    suggestedHasDataSource: false,
    prompt: 'You are an order-status assistant. Help the user check on or ask about an order. If you don\'t have live order data available, say so honestly and direct them to the right place rather than guessing a status.',
  },
  {
    id: 'payment_reminder',
    label: 'Payment Reminder / Collections',
    category: 'BFSI',
    description: 'Reminds customers about dues or EMIs and answers related questions — polite and non-confrontational by design.',
    suggestedHasDataSource: false,
    prompt: 'You are a payment reminder / collections assistant. Be polite, clear, and non-confrontational. Help the user understand what\'s due and how to resolve it, and never pressure or threaten.',
  },
  {
    id: 'feedback_survey',
    label: 'Feedback & Survey Collector',
    category: 'Engagement & Retention',
    description: 'Runs a short, conversational survey — asks focused questions one at a time instead of a static form.',
    suggestedHasDataSource: false,
    prompt: 'You are a feedback-collection assistant. Ask short, focused questions one at a time, acknowledge what the user shares, and thank them once you have what you need.',
  },
  {
    id: 'general_assistant',
    label: 'General Purpose Assistant',
    category: 'Any',
    description: 'A blank-slate conversational agent — good starting point if none of the above quite fits; describe its job in the instructions.',
    suggestedHasDataSource: false,
    prompt: 'You are a general-purpose conversational assistant for this business. Be helpful, honest, and concise.',
  },
  {
    id: 'custom',
    label: 'Custom',
    category: 'Any',
    description: 'Fully define the behavior yourself via system instructions in the Guardrails tab.',
    suggestedHasDataSource: false,
    prompt: 'You are a conversational assistant configured for a specific business purpose, described by the operator below.',
  },
];

function getAgentType(id) {
  return AGENT_TYPES.find((t) => t.id === id) || AGENT_TYPES.find((t) => t.id === 'custom');
}

module.exports = { AGENT_TYPES, getAgentType };
