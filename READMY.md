使い方

curl -s [http://10.20.10.5:3000/health](http://10.20.10.5:3000/health)

curl -s -X PUT [http://10.20.10.5:3000/lights/living1/state](http://10.20.10.5:3000/lights/living1/state) -H 'content-type: application/json' -d '{"state":"ON"}'

curl -s -X PUT [http://10.20.10.5:3000/lights/living1/state](http://10.20.10.5:3000/lights/living1/state) -H 'content-type: application/json' -d '{"state":"OFF"}'

curl -s [http://10.20.10.5:3000/lights/living1](http://10.20.10.5:3000/lights/living1)

使い方の例

curl -s -X PUT [http://10.20.10.5:3000/lights/living1/state](http://10.20.10.5:3000/lights/living1/state) -H 'content-type: application/json' -d '{"brightness":50}'

curl -s -X PUT [http://10.20.10.5:3000/lights/living1/state](http://10.20.10.5:3000/lights/living1/state) -H 'content-type: application/json' -d '{"state":"ON","brightness":254}'

