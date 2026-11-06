import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { personOf } from '../team.js';
import { audit } from '../audit.js';
import { assistantEnabled, planAutomation } from '../assistant.js';
import { automationFor, automationsFor, createAutomation, deleteAutomation, planningContext, runsFor, startAutomation, updateAutomation } from '../automations.js';
import { HttpError } from '../errors.js';

const router = Router();
router.use(requireAuth());

router.get('/', (req, res) => {
  const owner = personOf(req.user);
  res.json({ automations: automationsFor(owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), runs: runsFor(owner).slice(0, 100), context: planningContext(), aiEnabled: assistantEnabled() });
});

router.post('/plan', async (req, res) => {
  if (!assistantEnabled()) throw new HttpError(503, 'Set up the Assistant AI provider before creating an automation with AI');
  res.json(await planAutomation({ person: personOf(req.user), prompt: req.body?.prompt, context: planningContext() }));
});

router.post('/', (req, res) => {
  const item = createAutomation(personOf(req.user), req.body);
  audit(req, 'automation-created', personOf(req.user), item.name);
  res.status(201).json(item);
});

router.patch('/:id', (req, res) => res.json(updateAutomation(personOf(req.user), req.params.id, req.body)));
router.delete('/:id', (req, res) => { deleteAutomation(personOf(req.user), req.params.id); res.json({ ok: true }); });
router.get('/:id/runs', (req, res) => { automationFor(personOf(req.user), req.params.id); res.json(runsFor(personOf(req.user), req.params.id)); });
router.post('/:id/run', (req, res) => {
  const run = startAutomation(personOf(req.user), req.params.id, req.body?.input);
  audit(req, 'automation-started', personOf(req.user), run.automationName);
  res.status(202).json(run);
});

export default router;
