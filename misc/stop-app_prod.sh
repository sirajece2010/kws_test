#!/bin/bash
if [ -f /home/ubuntu/repo/kws_prod/api/app.pid ]; then
  cd /home/ubuntu/repo/kws_prod/api/
  PGID=$(ps -o pgid= -p $(cat ./app.pid) | tr -d ' ')
  kill -TERM -$PGID
  rm -rf ./app.pid
fi

