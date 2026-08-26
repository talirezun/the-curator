import { Router } from 'express';
import {
  sendMessage,
  listConversations,
  readConversation,
  deleteConversation,
} from '../brain/chat.js';
import { listDomains } from '../brain/files.js';

const router = Router();

// Conversation IDs are server-generated UUIDs. Reject non-conforming IDs
// before they reach the filesystem layer — defense in depth against
// path-traversal via crafted IDs.
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// List conversations for a domain
router.get('/:domain', async (req, res) => {
  try {
    const conversations = await listConversations(req.params.domain);
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load a full conversation
router.get('/:domain/:id', async (req, res) => {
  try {
    if (!CONVERSATION_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversationId' });
    }
    const conversation = await readConversation(req.params.domain, req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message (creates conversation if conversationId omitted)
router.post('/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const { message, conversationId, responseStyle, provider, model } = req.body;

    if (!message) return res.status(400).json({ error: 'message is required' });

    const domains = await listDomains();
    if (!domains.includes(domain)) {
      return res.status(400).json({ error: `Unknown domain: ${domain}` });
    }

    // responseStyle + provider + model are all optional; sendMessage normalises
    // each one (unknown responseStyle → 'balanced'; a provider without a SAVED
    // Settings key → the global active provider; a model that is not offerable
    // on that provider, or whose provider has no saved key → that provider's
    // default), so an absent or garbage value is always safe.
    //
    // DELIBERATELY NOT VALIDATED HERE. The model allow-list is applied at
    // getProviderInfo(), the single producer of the string both SDKs receive,
    // with normalizeChatModel as chat's own key gate in front of it. Adding a
    // check at this route would leave the other seven generateText entry points
    // open and create a second hand-maintained copy of the guard — the shape
    // that produced the v3.2.0 CRITICAL.
    const result = await sendMessage(domain, conversationId || null, message, { responseStyle, provider, model });
    res.json(result);
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a conversation
router.delete('/:domain/:id', async (req, res) => {
  try {
    if (!CONVERSATION_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversationId' });
    }
    await deleteConversation(req.params.domain, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
