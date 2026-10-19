FROM node:24-bookworm
# bun is for target repos that test with it, such as next-step-japan (pinned to its CI's version).
RUN npm install -g @anthropic-ai/claude-code@2.1.303 @earendil-works/pi-coding-agent@1.3.0 bun@1.4.3 \
 && npm cache clean --force
# Playwright and its headless Chromium for the QA stage. src/qa-browser.mjs is mounted at /opt/qa/qa.mjs, so its
# import of playwright resolves to /opt/qa/node_modules. The browser lives outside HOME, readable by any --user.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install --prefix /opt/qa playwright@1.64.1 \
 && /opt/qa/node_modules/.bin/playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force
