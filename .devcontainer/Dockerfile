ARG DEVCONTAINER_BASE_IMAGE=mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm
FROM ${DEVCONTAINER_BASE_IMAGE}

ARG YARN_VERSION=4.3.1

RUN corepack enable \
    && corepack prepare "yarn@${YARN_VERSION}" --activate \
    && yarn --version
