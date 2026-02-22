FROM node:24

RUN npm install -g @anthropic-ai/claude-code \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

WORKDIR /workspace
