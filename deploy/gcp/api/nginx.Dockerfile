FROM nginx:1.30.5-alpine3.24

COPY deploy/gcp/api/nginx.conf /etc/nginx/conf.d/default.conf
