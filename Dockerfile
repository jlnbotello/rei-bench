FROM docker.io/oven/bun:latest

# Install necessary system dependencies for the agent and benchmarker to work
# Git is required for cloning repos and extracting diffs.
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python-is-python3 \
    nodejs \
    npm \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set up git config to avoid warnings when agent tries to commit/diff
RUN git config --global user.email "bench@pi.local" && \
    git config --global user.name "Pi Benchmarker"

WORKDIR /pi-bench

# Fast appended layer to prevent busting the heavy cache above
RUN apt-get update && apt-get install -y python3-setuptools && rm -rf /var/lib/apt/lists/*
