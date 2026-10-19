FROM node:24-bookworm
# bun is for target repos that test with it, such as next-step-japan (pinned to its CI's version).
RUN npm install -g @anthropic-ai/claude-code@2.1.303 @earendil-works/pi-coding-agent@1.3.0 bun@1.4.3 \
 && npm cache clean --force
