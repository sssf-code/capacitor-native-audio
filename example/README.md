## Example app

This example demonstrates the **singleton native queue player** API.

- **Load Audiobook Queue / Load Podcast Queue**: replaces the native queue.
- **Background behavior**: while backgrounded, OS media controls still work natively; events may not deliver.
- **Resync**: when the app returns to foreground, call `getState()` / `getQueue()` to reconcile UI.

### Running

```bash
npm start
```
