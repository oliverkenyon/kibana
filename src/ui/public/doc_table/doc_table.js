import _ from 'lodash';
import html from './doc_table.html';
import { getSort } from './lib/get_sort';
import './doc_table.less';
import '../directives/truncated';
import '../directives/infinite_scroll';
import './components/table_header';
import './components/table_row';
import { dispatchRenderComplete } from '../render_complete';
import { uiModules } from '../modules';

import { getLimitedSearchResultsMessage } from './doc_table_strings';

uiModules.get('kibana')
  .directive('docTable', function (config, Notifier, getAppState, pagerFactory, $filter, courier) {
    return {
      restrict: 'E',
      template: html,
      scope: {
        sorting: '=',
        columns: '=',
        hits: '=?', // You really want either hits & indexPattern, OR searchSource
        indexPattern: '=?',
        searchSource: '=?',
        infiniteScroll: '=?',
        filter: '=?',
        filters: '=?',
        minimumVisibleRows: '=?',
        onAddColumn: '=?',
        onChangeSortOrder: '=?',
        onMoveColumn: '=?',
        onRemoveColumn: '=?',
      },
      link: function ($scope, $el) {
        const notify = new Notifier();

        $scope.actionPayloads = {};

        $scope.$watch('minimumVisibleRows', (minimumVisibleRows) => {
          $scope.limit = Math.max(minimumVisibleRows || 50, $scope.limit || 50);
        });

        $scope.persist = {
          sorting: $scope.sorting,
          columns: $scope.columns
        };

        const limitTo = $filter('limitTo');
        const calculateItemsOnPage = () => {
          $scope.pager.setTotalItems($scope.hits.length);
          $scope.pageOfItems = limitTo($scope.hits, $scope.pager.pageSize, $scope.pager.startIndex);
        };

        $scope.limitedResultsWarning = getLimitedSearchResultsMessage(config.get('discover:sampleSize'));

        $scope.addRows = function () {
          $scope.limit += 50;
        };

        // This exists to fix the problem of an empty initial column list not playing nice with watchCollection.
        $scope.$watch('columns', function (columns) {
          if (columns.length !== 0) return;

          const $state = getAppState();
          $scope.columns.push('_source');
          if ($state) $state.replace();
        });

        $scope.$watchCollection('columns', function (columns, oldColumns) {
          if (oldColumns.length === 1 && oldColumns[0] === '_source' && $scope.columns.length > 1) {
            _.pull($scope.columns, '_source');
          }

          if ($scope.columns.length === 0) $scope.columns.push('_source');

          $scope.resetSelectionsAndColumnCache();
        });

        $scope.$watch('searchSource', function () {
          if (!$scope.searchSource) return;

          $scope.indexPattern = $scope.searchSource.get('index');

          $scope.searchSource.size(config.get('discover:sampleSize'));
          $scope.searchSource.sort(getSort($scope.sorting, $scope.indexPattern));

          // Set the watcher after initialization
          $scope.$watchCollection('sorting', function (newSort, oldSort) {
          // Don't react if sort values didn't really change
            if (newSort === oldSort) return;
            $scope.searchSource.sort(getSort(newSort, $scope.indexPattern));
            $scope.searchSource.fetchQueued();
          });

          $scope.$on('$destroy', function () {
            if ($scope.searchSource) $scope.searchSource.destroy();
          });

          function onResults(resp) {
          // Reset infinite scroll limit
            $scope.limit = 50;

            // Abort if something changed
            if ($scope.searchSource !== $scope.searchSource) return;

            $scope.hits = resp.hits.hits;
            if ($scope.hits.length === 0) {
              dispatchRenderComplete($el[0]);
            }
            // We limit the number of returned results, but we want to show the actual number of hits, not
            // just how many we retrieved.
            $scope.totalHitCount = resp.hits.total;
            $scope.pager = pagerFactory.create($scope.hits.length, 50, 1);
            calculateItemsOnPage();

            return $scope.searchSource.onResults().then(onResults);
          }

          function startSearching() {
            $scope.searchSource.onResults()
              .then(onResults)
              .catch(error => {
                notify.error(error);
                startSearching();
              });
          }
          startSearching();
          courier.fetch();
        });

        $scope.pageOfItems = [];
        $scope.onPageNext = () => {
          $scope.pager.nextPage();
          calculateItemsOnPage();
        };

        $scope.onPagePrevious = () => {
          $scope.pager.previousPage();
          calculateItemsOnPage();
        };

        $scope.shouldShowLimitedResultsWarning = () => (
          !$scope.pager.hasNextPage && $scope.pager.totalItems < $scope.totalHitCount
        );

        $scope.hasCommandsAndMultiSelect = () => {

          let multiSelect = false;
          let hasCommands = false;

          for (const columnName of $scope.columns) {
            const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', columnName]);
            const formatType = columnDetails.format.param('type') || '';

            multiSelect = multiSelect || (formatType === 'checkbox');
            hasCommands = hasCommands || (formatType === 'command');

            if (multiSelect && hasCommands) {
              return true;
            }
          }

          return false;
        };


        $scope.getCommands = () => {
          // Cache in scope to prevent angular digest iterations error
          if ($scope.cacheCommands) {
            return $scope.cacheCommands;
          }

          const commands = [];
          for (const columnName of $scope.columns) {
            const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', columnName]);
            const formatType = columnDetails.format.param('type') || '';

            if (formatType === 'command') {
              const command = {
                name: columnName,
                label: columnDetails.format.convert('text')
              };

              commands.push(command);
            }
          }

          $scope.cacheCommands = commands;
          return commands;
        };

        $scope.resetSelectionsAndColumnCache = () => {
          $scope.setAllCheckboxes(false);
          $scope.actionPayloads = {};
          $scope.cacheCommands = null;
        };

        $scope.setAllCheckboxes = (checked) => {
          const visibleCheckboxes = document.querySelectorAll('input.discover-command-checkbox');
          visibleCheckboxes && visibleCheckboxes.forEach(checkbox => {
            checkbox.checked = checked;
          });
        };

        $scope.setAllSelected = (checked) => {
          $scope.setAllCheckboxes(checked);
          $scope.actionPayloads = {};

          if (checked) {
            const commandColumnNames = [];
            for (const columnName of $scope.columns) {
              const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', columnName]);
              const formatType = columnDetails.format.param('type') || '';

              if (formatType === 'command') {
                commandColumnNames.push(columnName);
                $scope.actionPayloads[columnName] = [];
              }
            }

            let index = 0;
            for (const row of $scope.hits) {
              for (const columnName of commandColumnNames) {
                const actionPayload = row.fields[columnName][0];
                $scope.actionPayloads[columnName].push(actionPayload);
              }

              index++;
              if (index > $scope.limit) {
                break;
              }
            }
          }
        };

        $scope.executeBulkCommand = (commandName) => {
          const payloads = $scope.actionPayloads[commandName];
          if (payloads) {
            // Column name is used as the command name, as it gives us guarantee of uniqueness
            const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', commandName]);
            const urlTemplate = columnDetails.format.param('urlTemplate');

            console.info('Making bulk request using URL template: ' + urlTemplate);
            console.info('Payload count: ' + payloads.length);
          }
        };

        $scope.onClickInRow = (event, row) => {
          if (event && event.target && event.target.classList.contains('discover-command-button')) {
            // Button name is set to column name scripted field code
            const columnName = event.target.name;

            const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', columnName]);
            const urlTemplate = columnDetails.format.param('urlTemplate');
            const actionPayload = row.fields[columnName][0];

            console.info('Executing command at urlTemplate: ' + urlTemplate + ' with payload: ' + actionPayload);

          }
          else if (event && event.target && event.target.classList.contains('discover-command-checkbox')) {
            // the value of each command field will be the thing that is being sent with the command
            // for that particular row. If we store this, when the bulk action button is clicked, all we need
            // is to get the template from the field definition, and the list of values.
            $scope.columns.forEach(columnName => {
              const columnDetails = _.get($scope, ['indexPattern', 'fields', 'byName', columnName]);
              const formatType = columnDetails.format.param('type') || '';

              if (formatType === 'command') {
                const actionPayload = row.fields[columnName][0];

                if (event.target.checked) {
                  if ($scope.actionPayloads[columnName]) {
                    $scope.actionPayloads[columnName].indexOf(actionPayload) === -1
                      && $scope.actionPayloads[columnName].push(actionPayload);
                  }
                  else {
                    $scope.actionPayloads[columnName] = [actionPayload];
                  }
                }
                else {
                  if ($scope.actionPayloads[columnName]) {
                    $scope.actionPayloads[columnName] = $scope.actionPayloads[columnName].filter(item => item !== actionPayload);
                  }
                }
              }
            });
          }
        };
      }
    };
  });
