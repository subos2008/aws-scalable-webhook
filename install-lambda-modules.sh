#!/bin/bash

DIRS=`ls ./lambda-fns`

for DIR in $DIRS
do
  pushd ./lambda-fns/$DIR
  npm install
  popd
done
